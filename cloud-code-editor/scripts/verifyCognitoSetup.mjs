import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { getCognitoOAuthConfiguration } from '../server/services/cognitoOAuth.js';

const PROBE_REFRESH_TOKEN = 'devloop-verification-only-not-a-real-token';
const PROBE_CODE = 'devloop-verification-only-not-a-real-code';
const PROBE_VERIFIER = 'a'.repeat(43);

const checks = [];

function record(status, title, detail) {
  checks.push({ status, title, detail });
}

function runAwsCli(args) {
  try {
    return {
      ok: true,
      stdout: execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message,
    };
  }
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

async function verifyAppClientExists({ clientId, region, profile }) {
  const result = runAwsCli([
    'cognito-idp',
    'initiate-auth',
    '--auth-flow',
    'REFRESH_TOKEN_AUTH',
    '--client-id',
    clientId,
    '--auth-parameters',
    `REFRESH_TOKEN=${PROBE_REFRESH_TOKEN}`,
    '--region',
    region,
    ...(profile ? ['--profile', profile] : []),
  ]);

  if (result.ok) {
    return { exists: true, reason: 'The pool accepted the client id.' };
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (/does not exist/i.test(output)) {
    return { exists: false, reason: 'Cognito reports that this app client does not exist in the pool.' };
  }
  if (/InvalidClientIdException/i.test(output)) {
    return { exists: false, reason: 'Cognito rejected the app client id as invalid.' };
  }
  if (/AccessDenied/i.test(output)) {
    return { exists: null, reason: 'The AWS identity is not allowed to run this check.' };
  }
  if (/Invalid Refresh Token|NotAuthorizedException/i.test(output)) {
    return {
      exists: true,
      reason: 'The pool recognized the client id; only the probe refresh token was rejected.',
    };
  }
  return {
    exists: null,
    reason: `The app client check could not be completed: ${output.trim().split('\n').slice(-1)[0]}`,
  };
}

async function verifyLoginPage({ domain, clientId, callbackUrl }) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorizeUrl = new URL('/oauth2/authorize', domain);
  authorizeUrl.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: 'openid email',
    redirect_uri: callbackUrl,
    state: randomBytes(16).toString('base64url'),
    nonce: randomBytes(16).toString('base64url'),
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  let authorize;
  try {
    authorize = await fetch(authorizeUrl, { redirect: 'manual' });
  } catch (error) {
    return { ok: null, reason: `The authorization endpoint could not be reached: ${error.message}` };
  }

  const location = authorize.headers.get('location') ?? '';
  if (/\/error\?/i.test(location)) {
    const params = new URL(location).searchParams;
    const reason = params.get('error_description') ?? params.get('error') ?? 'unknown';
    return { ok: false, reason: `Cognito rejected the authorization request (${reason}).` };
  }
  if (!/\/login(?:\?|$)/i.test(location)) {
    return {
      ok: null,
      reason: `The authorization endpoint answered HTTP ${authorize.status} without a login page.`,
    };
  }

  let login;
  try {
    login = await fetch(location, { redirect: 'manual' });
  } catch (error) {
    return { ok: null, reason: `The login page could not be reached: ${error.message}` };
  }
  if (login.status >= 500) {
    return { ok: false, reason: `The login page returned HTTP ${login.status}.` };
  }
  const html = await login.text();
  if (!html.trim()) {
    return { ok: null, reason: `The login page returned HTTP ${login.status} with an empty body.` };
  }
  // The hosted page always ships the wording of its own error states, so the
  // sign-in form itself is what tells us that the page really renders.
  const rendersSignInForm = /class="cognito-form-header"/i.test(html)
    && /Sign in to your account/i.test(html);
  if (rendersSignInForm) {
    return { ok: true, reason: `The hosted login page renders for app client ${clientId}.` };
  }
  if (/Login pages unavailable/i.test(html)) {
    return {
      ok: false,
      branding: true,
      reason:
        'The hosted login page says "Login pages unavailable". The app client exists but has no managed login ' +
        'branding style assigned, so Cognito cannot render the sign-in page.',
    };
  }
  return {
    ok: null,
    reason: `The login page returned HTTP ${login.status} but did not render a sign-in form.`,
  };
}

function verifySignInAttribute({ userPoolId, region, profile }) {
  const result = runAwsCli([
    'cognito-idp',
    'describe-user-pool',
    '--user-pool-id',
    userPoolId,
    '--region',
    region,
    ...(profile ? ['--profile', profile] : []),
  ]);

  if (!result.ok) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (/AccessDenied/i.test(output)) {
      return {
        ok: null,
        reason: 'The AWS identity may not describe the user pool, so the sign-in attribute could not be read.',
      };
    }
    return {
      ok: null,
      reason: `The user pool could not be described: ${output.trim().split('\n').slice(-1)[0]}`,
    };
  }

  let pool;
  try {
    pool = JSON.parse(result.stdout);
  } catch {
    return { ok: null, reason: 'The user pool description could not be read.' };
  }

  const attributes = pool.UsernameAttributes ?? [];
  if (attributes.includes('email')) {
    return {
      ok: true,
      reason: 'The pool signs people in with their email address, which is the name DevLoop gives an account.',
    };
  }
  return {
    ok: false,
    reason:
      `The pool signs people in with ${attributes.length ? attributes.join(' and ') : 'their user name'}. ` +
      'DevLoop registers an account with the email address, so the pool has to use the email address as its ' +
      'sign-in attribute.',
  };
}

async function main() {
  let configuration;
  try {
    configuration = getCognitoOAuthConfiguration();
    record(
      'pass',
      'Local configuration',
      `region=${configuration.region} pool=${configuration.userPoolId} client=${configuration.clientId} ` +
        `domain=${configuration.domain} callback=${configuration.callbackUrl}`,
    );
  } catch (error) {
    record('fail', 'Local configuration', error.message);
    return;
  }

  const { region, userPoolId, clientId, domain, callbackUrl, clientSecret } = configuration;
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;

  let discovery;
  try {
    const response = await fetch(`${issuer}/.well-known/openid-configuration`);
    if (!response.ok) {
      record('fail', 'User pool discovery', `The discovery document returned HTTP ${response.status}.`);
      return;
    }
    discovery = await response.json();
    record('pass', 'User pool discovery', `issuer=${discovery.issuer}`);
  } catch (error) {
    record('fail', 'User pool discovery', `The discovery document could not be read: ${error.message}`);
    return;
  }

  if (discovery.issuer === issuer) {
    record('pass', 'Issuer matches the pool', discovery.issuer);
  } else {
    record('fail', 'Issuer matches the pool', `Expected ${issuer} but the pool reports ${discovery.issuer}.`);
  }

  const authorizationEndpoint = new URL(discovery.authorization_endpoint);
  if (authorizationEndpoint.origin === new URL(domain).origin) {
    record('pass', 'Hosted UI domain', `${domain} is the domain the pool publishes.`);
  } else {
    record(
      'fail',
      'Hosted UI domain',
      `COGNITO_DOMAIN is ${domain} but the pool publishes ${authorizationEndpoint.origin}.`,
    );
  }

  const supportedScopes = new Set(discovery.scopes_supported ?? []);
  const missingScopes = ['openid', 'email'].filter((scope) => !supportedScopes.has(scope));
  if (missingScopes.length === 0) {
    record('pass', 'Pool scopes', `openid and email are supported by the pool.`);
  } else {
    record('fail', 'Pool scopes', `The pool does not advertise: ${missingScopes.join(', ')}.`);
  }

  if ((discovery.response_types_supported ?? []).includes('code')) {
    record('pass', 'Authorization code flow', 'The pool advertises the authorization code response type.');
  } else {
    record('fail', 'Authorization code flow', 'The pool does not advertise the authorization code response type.');
  }

  const clientCheck = await verifyAppClientExists({
    clientId,
    region,
    profile: process.env.AWS_PROFILE,
  });
  if (clientCheck.exists === true) {
    record('pass', 'App client exists', clientCheck.reason);
  } else if (clientCheck.exists === false) {
    record('fail', 'App client exists', clientCheck.reason);
  } else {
    record('warn', 'App client exists', clientCheck.reason);
  }

  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code: PROBE_CODE,
    client_id: clientId,
    redirect_uri: callbackUrl,
    code_verifier: PROBE_VERIFIER,
  });
  if (clientSecret) {
    tokenBody.set('client_secret', clientSecret);
  }

  try {
    const response = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });
    const payload = await readJson(response);
    if (payload.error === 'invalid_grant') {
      record(
        'pass',
        'Client authentication method',
        'The app client is a public client, so no client secret is needed. Leaving COGNITO_CLIENT_SECRET empty is correct.',
      );
    } else if (payload.error === 'invalid_client') {
      record(
        'fail',
        'Client authentication method',
        'Cognito rejected the client credentials. Either the app client id is wrong, or the app client is confidential ' +
          'and COGNITO_CLIENT_SECRET must hold its secret.',
      );
    } else {
      record(
        'warn',
        'Client authentication method',
        `The token endpoint answered with ${payload.error ?? `HTTP ${response.status}`}.`,
      );
    }
  } catch (error) {
    record('warn', 'Client authentication method', `The token endpoint could not be reached: ${error.message}`);
  }

  const loginCheck = await verifyLoginPage({ domain, clientId, callbackUrl });
  if (loginCheck.ok === true) {
    record('pass', 'Hosted login page', loginCheck.reason);
  } else if (loginCheck.ok === false) {
    record('fail', 'Hosted login page', loginCheck.reason);
  } else {
    record('warn', 'Hosted login page', loginCheck.reason);
  }

  const signInAttribute = verifySignInAttribute({
    userPoolId,
    region,
    profile: process.env.AWS_PROFILE,
  });
  if (signInAttribute.ok === true) {
    record('pass', 'Sign-in attribute', signInAttribute.reason);
  } else if (signInAttribute.ok === false) {
    record('fail', 'Sign-in attribute', signInAttribute.reason);
  } else {
    record('warn', 'Sign-in attribute', signInAttribute.reason);
  }

  if (signInAttribute.ok === false) {
    record(
      'hint',
      'How to change the sign-in attribute',
      'Cognito cannot change the sign-in attribute of a pool that already exists. A pool that signs people in ' +
        'with their email address has to be created new (Username attributes -> Email), the app client has to ' +
        'be created for that pool, and the identifiers in .env have to point at it. Review the current AWS ' +
        'settings before creating anything.',
    );
  }

  if (clientCheck.exists === false) {
    record(
      'hint',
      'How to create the app client',
      'Run the following with an identity that may call cognito-idp:CreateUserPoolClient, then put the printed ' +
        'ClientId into VITE_COGNITO_CLIENT_ID and the printed ClientSecret (if any) into COGNITO_CLIENT_SECRET:\n' +
        `  aws cognito-idp create-user-pool-client --user-pool-id ${userPoolId} --client-name devloop --` +
        `allowed-o-auth-flows code --allowed-o-auth-scopes openid email --callback-urls ${callbackUrl} ` +
        `--logout-urls ${callbackUrl} --allowed-o-auth-flows-user-pool-client --region ${region}`,
    );
  }

  if (loginCheck.branding) {
    record(
      'hint',
      'How to fix the login page',
      'In the Amazon Cognito console open User pools -> ' +
        `${userPoolId} -> Branding -> Managed login, create or choose a style, then apply it to app client ` +
        `${clientId}. You can also open the app client under App clients -> Login pages and assign a managed ` +
        'login branding style there. A style is required whenever the pool uses managed login.',
    );
  }
}

await main();

const icons = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', hint: 'HINT' };
console.log('\nDevLoop Cognito setup verification\n');
for (const check of checks) {
  console.log(`${icons[check.status]}  ${check.title}`);
  for (const line of check.detail.split('\n')) {
    console.log(`      ${line}`);
  }
}
const failed = checks.filter((check) => check.status === 'fail').length;
const warned = checks.filter((check) => check.status === 'warn').length;
const passed = checks.filter((check) => check.status === 'pass').length;
console.log(
  `\n${passed} passed, ${warned} warning${warned === 1 ? '' : 's'}, ${failed} failed.\n`,
);
process.exitCode = failed > 0 ? 1 : 0;
