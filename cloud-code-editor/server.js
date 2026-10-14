import { createServer } from 'node:http';

const port = 3001;
const maxBodyBytes = 10_000;

const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/api/signup') {
    response.writeHead(404).end('Not found');
    return;
  }

  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBodyBytes) {
      response.writeHead(413).end('Request body too large');
      return;
    }
  }

  let details;
  try {
    details = JSON.parse(body);
  } catch {
    response.writeHead(400).end('Invalid JSON');
    return;
  }

  if (typeof details !== 'object' || details === null || Array.isArray(details)) {
    response.writeHead(400).end('Expected a JSON object');
    return;
  }

  const { firstName, lastName, email } = details;
  if (![firstName, lastName, email].every((value) => typeof value === 'string' && value.trim())) {
    response.writeHead(400).end('First name, last name, and email are required');
    return;
  }

  console.log('Signup details received:', {
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    email: email.trim(),
  });

  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ received: true }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Signup verification API listening at http://127.0.0.1:${port}`);
});
