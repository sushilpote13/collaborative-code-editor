# DevLoop Project Guide

This report explains the repository layout, the purpose of each source/configuration file, and how the main parts work together. It is written as a guide you can use to introduce the project to someone else.

## 1. Project in one minute

**DevLoop is a browser-based Java editor where signed-in users can create or join a room, edit Java files together in real time, and run the project.**

- The browser interface is built with **React** and **Vite**.
- **CodeMirror** displays and edits Java source code.
- **Yjs** represents the shared workspace and merges simultaneous edits.
- **Socket.IO** carries document changes, cursor/awareness data, and member activity between connected browsers.
- The **Express** API handles account, room, and Java-runner requests.
- **MongoDB**, accessed through **Mongoose**, stores users, room metadata, and the saved shared workspace.
- **Amazon Cognito** handles sign-up and sign-in. People use the **DevLoop-branded sign-in screen inside the app**, and the browser performs the password exchange with Cognito over the secure remote password (SRP) protocol. The API verifies the Cognito ID token, then uses a short-lived HTTP-only JWT cookie for API routes and Socket.IO.
- The server runs `javac` and `java` for the Run Java feature.

### A short presentation script

> “DevLoop is a collaborative Java coding workspace. The React frontend contains the login, room-selection, and editor screens. The Express backend handles authentication, room creation, persistence, and running Java. Each room has a Yjs document containing its Java files. Socket.IO sends document and presence updates between clients, and MongoDB keeps the room document so it survives a server restart. The editor uses CodeMirror, and users can compile and run the shared project from the browser.”

## 2. How the pieces fit together

```text
Browser
  React pages and CodeMirror
       | HTTP: /api/*
       | WebSocket: /socket.io
       v
Vite development server (proxy)
       |
       v
Express + Socket.IO API (port 3001)
  | authentication / rooms / Java runner
  | collaboration document and in-memory presence
  +---- MongoDB (users and persisted room state)
  +---- local JDK (javac and java)
```

### Typical user journey

1. The user signs up or logs in on the DevLoop-branded home screen. The screen asks for an email address and password, resolves the account name, and signs in with Cognito over SRP; a new account gets a six digit email-confirmation code, and a forgotten password is reset with a code plus a new password. The browser then sends the Cognito identity token to the API, which verifies it, stores or links the profile, and sets an HTTP-only authentication cookie.
2. The protected meeting page lets the user create a room or enter a room ID. Creating a room stores a new room with a starter `Main.java`.
3. The editor opens a Socket.IO connection. The server checks the cookie, verifies that the room exists, and returns its current Yjs state.
4. CodeMirror edits a Yjs text value for the active Java file. Socket.IO relays Yjs updates to other clients in that room; Yjs merges concurrent edits.
5. The server batches room-state writes briefly and stores the updated state in MongoDB. Presence/member lists are maintained in API-process memory.
6. When the user runs the program, the browser sends the Java source files and optional input to the authenticated Java API route. The server writes temporary files, compiles them, runs `Main`, and returns compiler/runtime output.

### Important limits and behavior

- A workspace must include `Main.java`; it can contain up to 20 Java files, each up to 32 KB, with a total source limit of 128 KB.
- Compilation has a 15-second limit; execution has an 8-second limit. Output is capped at 64 KB.
- The Java process runs as the same operating-system user as the API. **It is not a secure sandbox for untrusted code**; use only with code you trust.
- Shared code is persisted in MongoDB. Open tabs and some editor UI state are local to each browser. `Ctrl+S` also writes a browser-local workspace snapshot; live shared edits are synchronized independently.
- Presence is held in one API process and resets when that process restarts. A multi-instance deployment would need coordinated presence and a shared Socket.IO adapter.
- An invite link is an invitation: anyone with the link still needs an account and a valid login session.

## 3. Repository layout

There are two package manifests in the Git repository. The **active application** and its setup guide are in `cloud-code-editor/`; run its npm scripts from that directory. The repository-level `package.json` and `package-lock.json` are separate and list a smaller Monaco/Yjs dependency set. Do not confuse those files with the app manifest, which defines the Vite, API, test, and lint scripts described below.

```text
collaborative-code-editor/                 Git repository root
|-- .gitignore                              repository-level ignore rules
|-- package.json                            repository-level dependency manifest
|-- package-lock.json                       lockfile for that manifest
|-- node_modules/                           installed repository-level dependencies
`-- cloud-code-editor/                      DevLoop application
    |-- public/                             static browser assets
    |-- server/                             Express API and collaboration server
    |-- shared/                             code shared by frontend and backend
    |-- src/                                React application
    |-- test/                               automated Node tests
    |-- package.json                        application scripts and dependencies
    |-- README.md                           app setup and feature documentation
    |-- server.js                           API/Socket.IO process entry point
    `-- ...
```

`node_modules/` and `dist/` are generated/installed directories, not hand-maintained source. They are ignored by Git and are not itemized as source files in this guide.

## 4. File-by-file guide

### Repository-root files

| File | What it does |
| --- | --- |
| [`.gitignore`](../.gitignore) | Ignores installed dependencies and the nested app's generated `dist` output. |
| [`package.json`](../package.json) | Repository-level dependency manifest. It lists Monaco/Yjs dependencies but does not define the app's `dev`, `build`, `lint`, or `test` scripts. |
| [`package-lock.json`](../package-lock.json) | Pins the exact dependency tree for the repository-level manifest so installs can be reproduced. |

### Application root: `cloud-code-editor/`

| File | What it does |
| --- | --- |
| [`.env`](.env) | Local-only MongoDB, JWT signing, and Cognito configuration. It is ignored by Git; never share or commit its contents. |
| [`.env.example`](.env.example) | Safe template showing which environment variables need to be configured for a local run. Cognito settings stay blank until the existing pool values are confirmed. |
| [`.gitignore`](.gitignore) | Ignores dependencies, build output, logs, local environment files, and common editor files while allowing `.env.example` to be tracked. |
| [`.oxlintrc.json`](.oxlintrc.json) | Configures Oxlint and enables React-related lint rules, including the Rules of Hooks check. |
| [`DFSMazeSolver.java`](DFSMazeSolver.java) | Standalone console example of depth-first search through a small maze. It displays the search progress and resulting path; it is not part of the web app's room or Java-runner flow. |
| [`index.html`](index.html) | Vite's HTML page. It provides the browser root element, favicon, page metadata, and loads `src/main.jsx`. |
| [`package.json`](package.json) | The application manifest. It lists the React, Vite, Express, Mongoose, Socket.IO, Yjs, CodeMirror, authentication, and lint/test dependencies, plus the npm scripts. |
| [`package-lock.json`](package-lock.json) | Locks the nested application's dependency versions for repeatable installation. |
| [`scripts/verifyCognitoSetup.mjs`](scripts/verifyCognitoSetup.mjs) | Read-only Cognito setup check: local settings, pool discovery, hosted-UI domain, scopes, app-client existence, and client authentication method. |
| [`README.md`](README.md) | Main setup and user/developer documentation: MongoDB and environment setup, login, collaboration, Java execution, limits, and project checks. |
| [`server.js`](server.js) | Starts the backend process: loads environment variables, validates the MongoDB/JWT settings, connects to MongoDB, creates the HTTP and Socket.IO servers, registers collaboration handlers, and listens on port 3001. |
| [`vite.config.js`](vite.config.js) | Configures the React plugin and development proxies for `/api` HTTP requests and `/socket.io` WebSocket traffic to the backend. |

### Static assets: `public/` and `src/assets/`

| File | What it does |
| --- | --- |
| [`public/favicon.svg`](public/favicon.svg) | SVG favicon served by the browser tab. |
| [`public/icons.svg`](public/icons.svg) | SVG symbol sprite containing reusable social, documentation, and profile-related icon artwork. |
| [`src/assets/DevLoop Neon Cloud Logo.png`](src/assets/DevLoop%20Neon%20Cloud%20Logo.png) | DevLoop brand image imported and displayed by the home/login screen. |

### Shared code: `shared/`

| File | What it does |
| --- | --- |
| [`shared/initialWorkspace.js`](shared/initialWorkspace.js) | Builds the starter Java program and exports the default `Main.java` source. The frontend and room-creation API use the same starter so new workspaces are consistent. |

### Backend: `server/`

#### Server assembly, authentication, and controllers

| File | What it does |
| --- | --- |
| [`server/app.js`](server/app.js) | Creates the Express app, installs JSON-body and cookie middleware, mounts API routers, and returns consistent 404 and error responses. |
| [`server/controllers/authController.js`](server/controllers/authController.js) | Runs the sign-in and sign-up flows: it verifies the Cognito identity token that the browser sends, resolves an email address to the name Cognito knows, links or creates the MongoDB profile, issues the app session, and revokes it on logout. It also keeps the hosted-UI authorization-code + PKCE flow as a fallback. Only public user fields are returned. |
| [`server/middleware/requireAuth.js`](server/middleware/requireAuth.js) | Reads and verifies the session cookie for protected HTTP routes, rejects revoked or malformed sessions, and places the verified user ID on the request. |
| [`server/services/session.js`](server/services/session.js) | Signs and verifies the one-hour app session cookie, enforces the session purpose, and keeps an in-memory revocation list so logout invalidates a token immediately. |
| [`server/services/cognito.js`](server/services/cognito.js) | Validates the Cognito environment settings and verifies user-pool ID tokens (signature, issuer, expiry, token use, audience) against Cognito's signing keys. |
| [`server/services/cognitoOAuth.js`](server/services/cognitoOAuth.js) | Validates the OAuth settings, discovers the user pool's endpoints, builds the hosted-UI client (public client with PKCE, no secret), and produces the Cognito sign-out URL. |

#### Database models

| File | What it does |
| --- | --- |
| [`server/models/User.js`](server/models/User.js) | Defines the MongoDB user document: names, unique username/email, Cognito subject, the Cognito username, optional legacy password hash, and timestamps. |
| [`server/models/Room.js`](server/models/Room.js) | Defines a room document with a unique room ID, creator reference, binary Yjs workspace state, and timestamps. |

#### API routes and services

| File | What it does |
| --- | --- |
| [`server/routes/authRoutes.js`](server/routes/authRoutes.js) | Maps `/api/auth/login`, `/callback`, `/resolve-signin`, `/token`, `/session`, `/logout`, and `/me` to auth-controller functions; `/me` requires authentication. |
| [`server/routes/javaRoutes.js`](server/routes/javaRoutes.js) | Defines the authenticated `/api/java/run` endpoint. It validates filenames, required entry point, input, file count, and source-size limits before calling the Java runner. |
| [`server/routes/roomRoutes.js`](server/routes/roomRoutes.js) | Creates authenticated rooms with a seeded Yjs workspace and provides the authenticated room-presence update endpoint. It accepts model dependencies so route behavior can be tested without a real database. |
| [`server/services/javaRunner.js`](server/services/javaRunner.js) | Runs Java projects. It writes validated source files into a temporary directory, invokes `javac` and `java`, enforces time/output/memory-related process limits, translates missing JDK tools into API errors, and removes the temporary directory afterward. |
| [`server/services/roomPresence.js`](server/services/roomPresence.js) | Tracks room members and their connected socket IDs in process memory. It avoids counting multiple tabs as multiple users and removes users after their last socket disconnects. |

#### Real-time collaboration

| File | What it does |
| --- | --- |
| [`server/sockets/collaboration.js`](server/sockets/collaboration.js) | Authenticates Socket.IO handshakes using the cookie, loads and validates room Yjs documents, handles joining/leaving, relays document and awareness updates only within the room, updates presence, and schedules MongoDB persistence. |

### Frontend: `src/`

#### Application boot and routing

| File | What it does |
| --- | --- |
| [`src/main.jsx`](src/main.jsx) | Browser entry point. Imports global CSS, creates the React root, and renders the app in `StrictMode`. |
| [`src/App.jsx`](src/App.jsx) | Defines client-side routes: `/` for login/signup, `/meetings` for room selection, and `/editor/:roomId` for a room editor. Meeting and editor routes are protected by `RequireAuth`. |
| [`src/index.css`](src/index.css) | Establishes global font, box sizing, and full-window sizing for the page and React root. |

#### Pages

| File | What it does |
| --- | --- |
| [`src/pages/home.jsx`](src/pages/home.jsx) | Login/signup page. Holds form state, submits credentials to the auth API, handles account-not-found/existing-account transitions, and navigates to the meeting or requested editor route after authentication. |
| [`src/pages/home.css`](src/pages/home.css) | Styles the login/signup experience, including the branded intro panel, responsive layout, form controls, and authentication errors. |
| [`src/pages/meetingPage.jsx`](src/pages/meetingPage.jsx) | Authenticated room-selection page. Validates a typed room ID or calls the API to create a room, then navigates into the editor. |
| [`src/pages/meetingPage.css`](src/pages/meetingPage.css) | Styles the room-selection page and adapts it for narrow screens. |
| [`src/pages/editorPage.jsx`](src/pages/editorPage.jsx) | Authenticated editor route wrapper. Lazy-loads the larger CodeMirror editor component and shows a loading message while it loads. |

#### Authentication form components

| File | What it does |
| --- | --- |
| [`src/pages/home.jsx`](src/pages/home.jsx) | The branded authentication screen. It owns the screen flow (sign in, create account, confirm email, reset password, second factor, profile) and calls the Cognito client and the session API. |
| [`src/components/auth/LoginForm.jsx`](src/components/auth/LoginForm.jsx) | Email address and password fields, the forgot-password link, and the submit button of the sign-in screen. |
| [`src/components/auth/SignupForm.jsx`](src/components/auth/SignupForm.jsx) | Name, username, email, and password fields of the account-creation screen, with the browser-side constraints on the username. |
| [`src/components/auth/PasswordField.jsx`](src/components/auth/PasswordField.jsx) | Password input with a show/hide toggle and the live password-requirement checklist. |
| [`src/components/auth/CodeForm.jsx`](src/components/auth/CodeForm.jsx) | Six digit code input used for the email confirmation, the password reset, and the second factor. |
| [`src/components/auth/ProfileForm.jsx`](src/components/auth/ProfileForm.jsx) | Display name and username fields for the profile step that follows a first sign-in. |
| [`src/components/auth/RequireAuth.jsx`](src/components/auth/RequireAuth.jsx) | Calls `/api/auth/me` before rendering a protected page. It redirects unauthenticated users to login and shows an error if session verification itself fails. |
| [`src/lib/cognitoClient.js`](src/lib/cognitoClient.js) | Loads Amplify on demand, configures the user pool, and wraps the Cognito calls the screens need: sign in, sign up, confirm, resend, password reset, second factor, and sign out. |
| [`src/lib/cognito.js`](src/lib/cognito.js) | Talks to the app API: resolves the account name, exchanges the Cognito identity token for the session cookie, and handles the hosted-UI flow, session renewal, and sign-out. |
| [`src/lib/authValidation.js`](src/lib/authValidation.js) | Pure rules for the email address, username, password, and confirmation code that the screens check before contacting Cognito. |
| [`src/lib/authErrors.js`](src/lib/authErrors.js) | Turns a Cognito error into a message a person can act on, and recognizes the "this account already exists" case. |
| [`src/lib/authFlow.js`](src/lib/authFlow.js) | Pure rules that decide which sign-in screen a failure leads to, so a failed sign-up never leaves the browser on a screen that cannot continue. |
| [`src/lib/cognitoErrors.js`](src/lib/cognitoErrors.js) | Converts Cognito's public-client secret error into instructions to use an existing no-secret browser app client. |

#### Editor components and styles

| File | What it does |
| --- | --- |
| [`src/components/editor/CodeEditor.jsx`](src/components/editor/CodeEditor.jsx) | Main IDE screen and frontend workspace coordinator. It manages files/tabs, binds CodeMirror to the active Yjs text, syncs shared files to local React state, handles local snapshots and keyboard shortcuts, runs Java through the API, and renders explorer/search, members, output/input, theme, profile, and layout controls. |
| [`src/components/editor/codeEditor.css`](src/components/editor/codeEditor.css) | Styles the editor workbench: top bar, file explorer, tabs, CodeMirror area, members panel, input/output console, status bar, splitters, light theme, and responsive layouts. |
| [`src/components/editor/EditorToolbarButton.jsx`](src/components/editor/EditorToolbarButton.jsx) | Reusable accessible toolbar button with a small built-in SVG icon set for editor controls. |
| [`src/components/editor/PanelSplitter.jsx`](src/components/editor/PanelSplitter.jsx) | Accessible mouse/touch and keyboard resizer for the explorer, members panel, and output panel. |
| [`src/components/editor/QuickOpen.jsx`](src/components/editor/QuickOpen.jsx) | Small modal to filter workspace filenames and open a selected file; supports Enter and Escape keys. |

#### Collaboration hook

| File | What it does |
| --- | --- |
| [`src/hooks/useCollaborativeRoom.js`](src/hooks/useCollaborativeRoom.js) | Owns the browser's Socket.IO/Yjs connection for a room. It joins/rejoins, applies initial and remote Yjs state, sends local document and awareness updates, tracks member/activity/error state, and cleans up the socket and Yjs objects when the editor unmounts. |

### Automated tests: `test/`

| File | What it checks |
| --- | --- |
| [`test/collaboration.test.js`](test/collaboration.test.js) | Exercises Socket.IO authentication (including forged, purpose-less, and revoked sessions), rejection of unknown rooms and invalid updates, room-scoped broadcasts, join/leave activity, Yjs changes across clients, concurrent edit convergence, and persistence through a stubbed room model. |
| [`test/authRoutes.test.js`](test/authRoutes.test.js) | Checks the PKCE transaction, profile provisioning/linking, verified email, and missing configuration without contacting AWS. |
| [`test/authSession.test.js`](test/authSession.test.js) | Checks the session cookie flags, purpose binding, expiry, revocation on logout, and rejection of forged or foreign-secret sessions. |
| [`test/authTokenSession.test.js`](test/authTokenSession.test.js) | Checks the identity-token exchange: the session that starts, the stored Cognito username, the linking of an existing account, the profile step, and the rejection of unverified, unverifiable, and missing tokens. |
| [`test/authUiHelpers.test.js`](test/authUiHelpers.test.js) | Checks the browser-side rules for the email address, username, password, and code, plus the mapping of Cognito errors to readable messages. |
| [`test/authAccountLinking.test.js`](test/authAccountLinking.test.js) | Checks the linking of the account behind a verified identity token: an account of an older Cognito identity is linked again instead of refused, a returning account signs in, a first time account is created, and the name of somebody else is not taken over. |
| [`test/authFlow.test.js`](test/authFlow.test.js) | Checks the screen a failed sign-in leads to, and the message that goes with it, for the API codes and the Cognito errors. |
| [`test/cognitoRetry.test.js`](test/cognitoRetry.test.js) | Checks that a sign-in that is refused twice is tried again, that every timer of the retry gets a function, and that the message of the server is kept when the retry gives up. |
| [`test/cognitoPkce.test.js`](test/cognitoPkce.test.js) | Checks the S256 challenge, fresh state/nonce/verifier per attempt, state mismatch handling, and single-use authorization codes. |
| [`test/cognitoTokenValidation.test.js`](test/cognitoTokenValidation.test.js) | Checks ID-token signature, issuer, expiry, audience, token-use, and subject validation using injected JWKS. |
| [`test/cognitoConfig.test.js`](test/cognitoConfig.test.js) | Checks OAuth configuration validation, the public-client default, domain/region matching, callback/logout URL rules, and the sign-out URL. |
| [`test/roomPresence.test.js`](test/roomPresence.test.js) | Checks that multiple tabs count as one member, and that a member leaves only after their last socket disconnects. |
| [`test/roomRoutes.test.js`](test/roomRoutes.test.js) | Checks the shared starter-code template, authenticated room creation, the stored Yjs starter state, and rejection of room creation without an auth cookie. |

## 5. API and real-time vocabulary

### HTTP routes

| Method and path | Purpose |
| --- | --- |
| `POST /api/auth/login` | Start the hosted-UI PKCE flow and return the Cognito authorization URL (fallback path). |
| `POST /api/auth/callback` | Validate state, exchange the authorization code, verify the ID token, and set the app session cookie. |
| `POST /api/auth/resolve-signin` | Map the email address a person typed to the name Cognito knows the account by. |
| `POST /api/auth/token` | Verify the Cognito identity token, provision or link the profile, and set the app session cookie. |
| `POST /api/auth/session` | Verify a Cognito ID token, provision/link the user profile, and set the API session cookie. |
| `POST /api/auth/logout` | Revoke and clear the app session, clear OAuth flow cookies, and return the Cognito sign-out URL when configured. |
| `GET /api/auth/me` | Return the current public user for a valid cookie. |
| `POST /api/rooms` | Create a room seeded with `Main.java`. |
| `PUT /api/rooms/:roomId/presence` | Refresh a signed-in user's in-memory room presence. |
| `POST /api/java/run` | Compile and execute a submitted Java workspace. |

### Socket.IO events

| Event | Direction and meaning |
| --- | --- |
| `room:join` | Client asks to join a room; server acknowledges with members and the current Yjs state. |
| `room:leave` | Client leaves its current room. |
| `room:document-update` | Client sends a Yjs workspace change; server validates, applies, persists, and broadcasts it to the other room members. |
| `room:awareness-update` | Client sends cursor/presence awareness information for the other members. |
| `room:members` | Server broadcasts the current member list. |
| `room:participant-joined` / `room:participant-left` | Server announces when a user enters or leaves (not merely when an additional tab opens). |
| `room:error` | Server tells a client that an update or persistence action failed. |

## 6. How to run and verify it

Run these commands from `cloud-code-editor/`, not the repository root:

```powershell
npm install
Copy-Item .env.example .env
# Set MONGODB_URI and a private random JWT_SECRET in .env.
# Add Cognito values only after confirming the existing pool and app client in AWS Console.
npm run verify:cognito
npm run dev
```

`npm run verify:cognito` reads the local Cognito settings, loads the user pool's discovery document, and checks that the configured app client exists and does not need a secret. It only reads; it never changes AWS. It prints the exact `aws cognito-idp create-user-pool-client` command when the app client is missing.

MongoDB must be available, and the backend needs a JDK with both `javac` and `java` on `PATH` for the Run Java feature. `npm run dev` starts the API and Vite together; Vite serves the UI and proxies API/WebSocket traffic to port 3001.

Useful checks:

```powershell
npm test
npm run lint
npm run build
```

The scripts are defined in the nested app's `package.json`: `test` uses Node's built-in test runner, `lint` uses Oxlint, and `build` creates the Vite production bundle in `dist/`.

## 7. A few terms in plain language

- **API:** The backend endpoints the browser calls for account, room, and run operations.
- **Cookie / JWT:** The browser stores a signed login token in an HTTP-only cookie; JavaScript on the page cannot read that cookie directly.
- **Yjs document:** A shared, mergeable representation of the files and text in a room.
- **Awareness:** Temporary collaboration metadata such as who is present and where their cursor is; it is distinct from saved source code.
- **Presence:** The server's current list of connected room users. In this app it is in memory, unlike the room's saved document.
- **Vite proxy:** Development routing that lets the browser call `/api` and `/socket.io` on the frontend origin while the actual handlers run on the API server.
- **Temporary Java workspace:** A short-lived directory used by the backend to compile and run the uploaded Java source, then deleted when execution ends.
