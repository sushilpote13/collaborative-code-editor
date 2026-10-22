# DevLoop

React + Vite frontend with an Express, Mongoose, and MongoDB API. Amazon Cognito handles account registration and sign-in through a **custom DevLoop-branded sign-in screen inside the app**; authenticated users can share Java workspaces in real time using Socket.IO and Yjs.

## Authentication setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Make sure MongoDB is running locally, or create a MongoDB Atlas cluster and copy its connection URI.
3. Create a local environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

4. Generate the API session signing secret:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

   Put the generated value in `.env` as `JWT_SECRET=...`. Set `MONGODB_URI` to your local MongoDB URI or Atlas URI. Keep `.env` private; it is ignored by Git.

5. Configure the existing Cognito user pool and app client in `.env`:

   ```dotenv
   VITE_AWS_REGION=your-region
   VITE_COGNITO_USER_POOL_ID=your-existing-user-pool-id
   VITE_COGNITO_CLIENT_ID=your-existing-app-client-id
   COGNITO_DOMAIN=https://your-existing-domain.auth.your-region.amazoncognito.com
   COGNITO_CLIENT_SECRET=
   COGNITO_CALLBACK_URL=http://localhost:5173/
   COGNITO_LOGOUT_URL=http://localhost:5173/
   ```

   Find the region and user pool ID in **Amazon Cognito → User pools → your existing pool → Overview**. Find the app client ID under **App integration → App clients → your existing app client**; find its hosted-login domain under **App integration → Domain**. `VITE_COGNITO_CLIENT_ID` must be the client ID Cognito actually assigned to an app client in that pool. A malformed or unregistered client ID makes every sign-in fail.

   The frontend talks to the user pool directly with the **secure remote password (SRP)** protocol, so the password never travels in readable form and the app client needs no secret. The app client must allow the `ALLOW_USER_SRP_AUTH` and `ALLOW_REFRESH_TOKEN_AUTH` authentication flows. The user pool must be created with **Email** as its sign-in attribute (Cognito calls this *Username attributes*), because DevLoop registers an account with the email address and signs it in with that same address. The name a person picks inside DevLoop is not the account name; it travels with the account as the `preferred_username` attribute. A pool that signs people in with a user name cannot be used by DevLoop, and Cognito cannot change this setting after the pool has been created. The hosted-UI variables stay configured because the server still supports the hosted-UI sign-in as a fallback and for sign-out. The region, pool ID, client ID, domain, and callback URL are identifiers, not secrets; a client secret is a private credential and must stay only in the ignored backend `.env`, never in a `VITE_` variable, source file, or chat. Never put AWS access keys in the frontend.

   The app client must have the authorization-code OAuth grant, the `openid` and `email` scopes, and `http://localhost:5173/` listed as an allowed callback URL (exact match, including the trailing slash) so the hosted-UI fallback keeps working. For complete Cognito sign-out, `COGNITO_LOGOUT_URL` must also be listed as an allowed sign-out URL. Do not create a pool or app client, or change existing AWS settings without first reviewing the current client configuration.

6. Verify the Cognito wiring before signing in:

   ```powershell
   npm run verify:cognito
   ```

   The script checks the local configuration, the pool's own discovery document, the hosted-UI domain, the pool scopes, whether the configured app client exists, whether the client needs a secret, whether the hosted login page actually renders, and whether the pool signs people in with their email address. If the app client is missing it prints the exact `aws cognito-idp create-user-pool-client` command; if the app client exists but has no managed-login branding style it prints instructions for assigning one; if the pool signs people in with a user name it explains that the pool has to be created with **Email** as the sign-in attribute. It only reads; it never creates or changes anything in AWS.

7. Start the backend and frontend together from this directory:

   ```powershell
   npm run dev
   ```

This starts the API on port `3001` and Vite, which proxies `/api` requests to the API. The API must connect to MongoDB before login and signup can work.

If the browser reports `502` for an `/api` request, check the terminal for an API or MongoDB startup error. You can also run `npm run dev:api` separately when you want to run the API without Vite.

## Login and signup flow

- People sign in on the **DevLoop sign-in screen**, not on a Cognito-hosted page. The screen is part of the app, so it carries the DevLoop logo, colours, and wording, and it offers sign-in, account creation, email confirmation, and password reset.
- The browser performs the sign-in itself with **SRP** (`InitiateAuth` → `RespondToAuthChallenge`), so the password is never sent in readable form. Cognito still manages the password rules, email verification, and MFA.
- The screen shows one step at a time: **sign in**, **create account**, **confirm your email** (six digit code), **reset your password** (code plus a new password), and **second factor** when the pool asks for MFA.
- DevLoop resolves the account first: the typed email address is looked up in the app database (`POST /api/auth/resolve-signin`) and mapped to the name Cognito knows the account by, which is the email address the account was registered with. When nothing matches, the typed address is folded to lower case and sent to Cognito, which is the form every DevLoop account is registered in. Only one sign-in attempt is made per form submission so a wrong guess can never lock an account.
- Cognito's answer is exchanged for an app session: the browser sends the identity token to `POST /api/auth/token`, the API verifies it (signature, issuer, expiry, token use, audience), links or creates the profile, and answers with a one-hour, HTTP-only session cookie. The browser then drops the Cognito tokens, so the only session the app keeps is its own.
- DevLoop stores a profile keyed to the verified Cognito subject and remembers the email address that names the account in Cognito, so the next sign-in resolves straight to the account. The name inside DevLoop comes from the `preferred_username` attribute of the account, never from the internal Cognito user name. Profiles use a unique normalized username and email. Existing local accounts are linked only when the Cognito email is verified and matches.
- The API keeps the hosted-UI sign-in (`POST /api/auth/login` + `POST /api/auth/callback`) as a fallback, and **log out** revokes the session on the server (the token stops working immediately, not just when its cookie is cleared) and also clears Cognito's hosted session when `COGNITO_LOGOUT_URL` is configured to an allowed sign-out URL.
- MongoDB/Mongoose creates the database and `users` collection when the first profile is stored. Passwords are managed by Cognito and are not stored by DevLoop.

## Real-time collaboration

- Select **Create new meeting** to create a room and open its Java workspace. Room IDs are random UUIDs and rooms are stored in MongoDB.
- To join, enter a room ID or open a copied invite URL. Invitees must have an account and be logged in. The server checks the signed authentication cookie, validates the room ID, and confirms the room exists before admitting a Socket.IO connection.
- Use **Copy invite link** in the editor to share the current room. Anyone with that link and a signed-in account can join; treat it as an invitation.
- Each CodeMirror editor is bound to the Yjs text for its active file, and Socket.IO relays binary Yjs and awareness updates between members of that room. Concurrent edits merge through Yjs; reconnecting and late-joining clients receive the latest room document. The shared workspace state is persisted with its MongoDB room, so code remains available after API restarts. File creation, renaming, and deletion are shared too; open tabs remain local to each browser.
- Member lists and join/leave notices update over Socket.IO. Presence is held in API process memory and resets when the API restarts. This setup expects one API instance; multiple instances require a shared Socket.IO adapter and coordinated presence.
- Vite proxies both `/api` HTTP requests and `/socket.io` WebSocket connections to the API on port `3001`. Start the frontend and API together with `npm run dev`.

## Java editor

- The authenticated editor opens `Main.java` with Java syntax highlighting and a runnable `Hello, DevLoop!` starter. New Java files receive the same starter with a class name matching the filename. Use the **+** button in the Explorer to create Java files, and use the file-row controls to rename or delete additional files. `Main.java` is kept as the run entry point.
- Click **Run Java** to compile the workspace's Java files together and run the `Main` class, with optional standard input. A workspace can contain up to 20 files; each file is limited to 32 KB and a project to 128 KB. Compiler diagnostics, standard output, and runtime errors appear in the output panel.
- Collapse or resize the Explorer, Members, and output panels with their toolbar toggles and splitters. The editor supports open-file tabs, dark/light themes, zoom controls, and fullscreen mode.
- Use **Ctrl+S** to save the current workspace snapshot in this browser; live Yjs updates are synchronized to the room automatically. **Ctrl+P** opens a file, and **Ctrl+Shift+F** searches across workspace files.
- The console can be collapsed, resized, cleared, and rerun. Stopping a running program is not available because the current Java API runs synchronously and does not expose cancellation.
- Install a JDK and make sure both `javac` and `java` are on `PATH`.
- The local runner limits source to 32 KB, compile time to 15 seconds, execution time to 8 seconds, Java heap to 128 MB, and output to 64 KB. It runs code as the same operating-system user as the backend; it is for local development with code you trust, **not** a secure sandbox for public or untrusted code.

Run checks with:

```powershell
npm test
npm run lint
npm run build
```
