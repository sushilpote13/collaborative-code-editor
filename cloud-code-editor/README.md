# DevLoop

React + Vite frontend with an Express, Mongoose, and MongoDB API. Authenticated users can share Java workspaces in real time using Socket.IO and Yjs.

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

4. Generate a signing secret:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

   Put the generated value in `.env` as `JWT_SECRET=...`. Set `MONGODB_URI` to your local MongoDB URI or Atlas URI. Keep `.env` private; it is ignored by Git.

5. Start the backend and frontend together from this directory:

   ```powershell
   npm run dev
   ```

This starts the API on port `3001` and Vite, which proxies `/api` requests to the API. The API must connect to MongoDB before login and signup can work.

If the browser reports `502` for an `/api` request, check the terminal for an API or MongoDB startup error. You can also run `npm run dev:api` separately when you want to run the API without Vite.

## Login and signup flow

- The app first shows the login form and checks the email/password against MongoDB.
- If no account exists for the email, it switches to signup and keeps the email entered. After login or signup, the app opens the room selection page.
- Signup stores names, a unique normalized username, and a normalized email in MongoDB. Usernames use 3-20 letters, numbers, or underscores and start with a letter. Passwords are bcrypt-hashed before storage.
- Login and signup set a short-lived, HTTP-only authentication cookie. The editor route verifies the cookie; use **Log out** to clear it.
- The database and `users` collection are created by MongoDB/Mongoose when the first account is stored. Passwords are never logged or returned to the browser.

## Real-time collaboration

- Select **Create new meeting** to create a room and open its Java workspace. Room IDs are random UUIDs and rooms are stored in MongoDB.
- To join, enter a room ID or open a copied invite URL. Invitees must have an account and be logged in. The server checks the signed authentication cookie, validates the room ID, and confirms the room exists before admitting a Socket.IO connection.
- Use **Copy invite link** in the editor to share the current room. Anyone with that link and a signed-in account can join; treat it as an invitation.
- CodeMirror edits are synchronized as Yjs shared text documents. The shared workspace state is persisted with its MongoDB room, so code remains available after reconnects and API restarts. File creation, renaming, and deletion are shared too; open tabs remain local to each browser.
- Member lists and join/leave notices update over Socket.IO. Presence is held in API process memory and resets when the API restarts. This setup expects one API instance; multiple instances require a shared Socket.IO adapter and coordinated presence.
- Vite proxies both `/api` HTTP requests and `/socket.io` WebSocket connections to the API on port `3001`. Start the frontend and API together with `npm run dev`.

## Java editor

- The authenticated editor opens `Main.java` with Java syntax highlighting. Use the **+** button in the Explorer to create Java files, and use the file-row controls to rename or delete additional files. `Main.java` is kept as the run entry point.
- Click **Run Java** to compile the workspace's Java files together and run the `Main` class, with optional standard input. A workspace can contain up to 20 files; each file is limited to 32 KB and a project to 128 KB. Compiler diagnostics, standard output, and runtime errors appear in the output panel.
- Install a JDK and make sure both `javac` and `java` are on `PATH`.
- The local runner limits source to 32 KB, compile time to 15 seconds, execution time to 8 seconds, Java heap to 128 MB, and output to 64 KB. It runs code as the same operating-system user as the backend; it is for local development with code you trust, **not** a secure sandbox for public or untrusted code.

Run checks with:

```powershell
npm test
npm run lint
npm run build
```
