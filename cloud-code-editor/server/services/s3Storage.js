import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  paginateListObjectsV2,
} from '@aws-sdk/client-s3';

const s3Client = new S3Client({
  region: process.env.S3_REGION || process.env.AWS_REGION || process.env.VITE_AWS_REGION || 'ap-southeast-2',
  ...(
    process.env.AWS_PROFILE || process.env.NODE_ENV !== 'production'
      ? { profile: process.env.AWS_PROFILE || 'devloop' }
      : {}
  ),
});

function getConfiguredBucket() {
  return process.env.S3_BUCKET || process.env.S3_BUCKET_NAME || 'collaborative-java-editor';
}

function projectPrefix(roomId) {
  return `projects/${roomId}/`;
}

const workspaceFileName = 'workspace.json';
const javaFileNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,59}\.java$/;

export function createS3Storage({ client = s3Client, getBucket = getConfiguredBucket } = {}) {
  const projectOperations = new Map();
  const initializedProjects = new Set();
  const legacyKeysByProject = new Map();

  function serializeProjectOperation(roomId, operation) {
    const previous = projectOperations.get(roomId) ?? Promise.resolve();
    const current = previous.catch((error) => {
      console.error('A previous project storage operation failed:', error);
    }).then(operation);
    projectOperations.set(roomId, current);
    return current.finally(() => {
      if (projectOperations.get(roomId) === current) {
        projectOperations.delete(roomId);
      }
    });
  }

  function validateFiles(files) {
    if (!Array.isArray(files) || files.length < 1 || files.length > 20) {
      throw new Error('A project must contain between 1 and 20 Java files.');
    }
    const names = new Set();
    let totalBytes = 0;
    for (const file of files) {
      if (
        !file ||
        typeof file.name !== 'string' ||
        !javaFileNamePattern.test(file.name) ||
        typeof file.source !== 'string' ||
        names.has(file.name.toLowerCase())
      ) {
        throw new Error('The project contains an invalid or duplicate Java file.');
      }
      names.add(file.name.toLowerCase());
      const size = Buffer.byteLength(file.source, 'utf8');
      if (size > 32 * 1024) {
        throw new Error(`${file.name} must be no larger than 32 KB.`);
      }
      totalBytes += size;
      if (totalBytes > 128 * 1024) {
        throw new Error('The Java project must be no larger than 128 KB.');
      }
    }
    if (!names.has('main.java')) {
      throw new Error('The Java project must include Main.java.');
    }
  }

  async function saveWorkspace({ roomId, files }) {
    await client.send(new PutObjectCommand({
      Bucket: getBucket(),
      Key: `${projectPrefix(roomId)}${workspaceFileName}`,
      Body: JSON.stringify({ files }),
      ContentType: 'application/json; charset=utf-8',
      ServerSideEncryption: 'AES256',
    }));
  }

  async function loadObject({ key }) {
    const result = await client.send(new GetObjectCommand({
      Bucket: getBucket(),
      Key: key,
    }));
    if (!result.Body) {
      throw new Error('S3 returned an empty project file response.');
    }
    return {
      body: await result.Body.transformToString('utf-8'),
      lastModified: result.LastModified?.toISOString() ?? null,
    };
  }

  async function listLegacyObjects(roomId) {
    const objects = [];
    for await (const page of paginateListObjectsV2(
      { client, pageSize: 1000 },
      { Bucket: getBucket(), Prefix: projectPrefix(roomId) },
    )) {
      for (const object of page.Contents ?? []) {
        const key = object.Key;
        const name = key?.slice(projectPrefix(roomId).length);
        if (name && javaFileNamePattern.test(name)) {
          objects.push({ key, name });
        }
      }
    }
    return objects.sort((first, second) => first.name.localeCompare(second.name));
  }

  async function loadLegacyWorkspace(roomId) {
    const legacyObjects = await listLegacyObjects(roomId);
    if (legacyObjects.length === 0) {
      return { files: [], legacyKeys: [], lastModified: null };
    }
    const files = await Promise.all(legacyObjects.map(async ({ key, name }) => ({
      name,
      source: (await loadObject({ key })).body,
    })));
    validateFiles(files);
    return {
      files,
      legacyKeys: legacyObjects.map(({ key }) => key),
      lastModified: null,
    };
  }

  async function readWorkspace(roomId) {
    try {
      const result = await loadObject({
        key: `${projectPrefix(roomId)}${workspaceFileName}`,
      });
      const workspace = JSON.parse(result.body);
      validateFiles(workspace.files);
      initializedProjects.add(roomId);
      return {
        files: workspace.files,
        legacyKeys: [],
        lastModified: result.lastModified,
      };
    } catch (error) {
      if (!isS3ObjectNotFound(error)) {
        throw error;
      }
      const workspace = await loadLegacyWorkspace(roomId);
      if (workspace.legacyKeys.length === 0) {
        initializedProjects.add(roomId);
      } else {
        legacyKeysByProject.set(roomId, workspace.legacyKeys);
      }
      return workspace;
    }
  }

  async function writeWorkspace({ roomId, files, legacyKeys = [] }) {
    validateFiles(files);
    await saveWorkspace({ roomId, files });
    if (legacyKeys.length > 0) {
      const saved = await loadObject({
        key: `${projectPrefix(roomId)}${workspaceFileName}`,
      });
      const verified = JSON.parse(saved.body);
      validateFiles(verified.files);
      if (JSON.stringify(verified.files) !== JSON.stringify(files)) {
        throw new Error('The S3 project workspace could not be verified.');
      }
      await Promise.all(legacyKeys.map((key) => client.send(new DeleteObjectCommand({
        Bucket: getBucket(),
        Key: key,
      }))));
    }
    initializedProjects.add(roomId);
    legacyKeysByProject.delete(roomId);
  }

  function listWorkspaceFiles(workspace) {
    return workspace.files.map(({ name, source }) => ({
      name,
      size: Buffer.byteLength(source, 'utf8'),
      lastModified: workspace.lastModified,
    }));
  }

  async function deleteFile({ roomId, fileName }) {
    const workspace = await readWorkspace(roomId);
    if (!workspace.files.some((file) => file.name === fileName)) {
      return;
    }
    const files = workspace.files.filter((file) => file.name !== fileName);
    await writeWorkspace({ roomId, files, legacyKeys: workspace.legacyKeys });
  }

  return {
    saveProjectFile({ roomId, fileName, source }) {
      return serializeProjectOperation(
        roomId,
        async () => {
          const workspace = await readWorkspace(roomId);
          const currentIndex = workspace.files.findIndex((file) => file.name === fileName);
          const files = [...workspace.files];
          if (currentIndex < 0) {
            files.push({ name: fileName, source });
          } else {
            files[currentIndex] = { name: fileName, source };
          }
          await writeWorkspace({ roomId, files, legacyKeys: workspace.legacyKeys });
        },
      );
    },

    loadProjectFile({ roomId, fileName }) {
      return serializeProjectOperation(
        roomId,
        async () => {
          const workspace = await readWorkspace(roomId);
          const file = workspace.files.find((entry) => entry.name === fileName);
          if (!file) {
            const error = new Error('The requested project file does not exist.');
            error.name = 'NoSuchKey';
            throw error;
          }
          return file.source;
        },
      );
    },

    listProjectFiles({ roomId }) {
      return serializeProjectOperation(roomId, async () =>
        listWorkspaceFiles(await readWorkspace(roomId)),
      );
    },

    loadProjectFiles({ roomId }) {
      return serializeProjectOperation(roomId, async () => {
        return (await readWorkspace(roomId)).files;
      });
    },

    replaceProjectFiles({ roomId, files }) {
      return serializeProjectOperation(roomId, async () => {
        let legacyKeys = legacyKeysByProject.get(roomId) ?? [];
        if (!initializedProjects.has(roomId) && legacyKeys.length === 0) {
          const existing = await readWorkspace(roomId);
          legacyKeys = existing.legacyKeys;
        }
        await writeWorkspace({ roomId, files, legacyKeys });
      });
    },

    deleteProjectFile({ roomId, fileName }) {
      return serializeProjectOperation(
        roomId,
        () => deleteFile({ roomId, fileName }),
      );
    },
  };
}

export function isS3ObjectNotFound(error) {
  return error?.name === 'NoSuchKey' || error?.name === 'NotFound';
}

export const s3Storage = createS3Storage();
