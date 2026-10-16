# DevLoop

React + Vite frontend with an Express, Mongoose, and MongoDB authentication API.

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
- If no account exists for the email, it switches to signup and keeps the email entered.
- Signup stores names, a unique normalized username, and a normalized email in MongoDB. Usernames use 3-20 letters, numbers, or underscores and start with a letter. Passwords are bcrypt-hashed before storage.
- Login and signup set a short-lived, HTTP-only authentication cookie. The editor route verifies the cookie; use **Log out** to clear it.
- The database and `users` collection are created by MongoDB/Mongoose when the first account is stored. Passwords are never logged or returned to the browser.

## Java editor

- The authenticated editor opens `Main.java` with Java syntax highlighting. Use the **+** button in the Explorer to create Java files, and use the file-row controls to rename or delete additional files. `Main.java` is kept as the run entry point.
- Files and open tabs are saved in this browser per user and workspace. This is local browser storage, not shared live storage between collaborators.
- The Members sidebar tracks authenticated users in the same room ID. The API refreshes presence every 10 seconds and removes members after 35 seconds without a heartbeat. Presence is held in API process memory, so it resets if the API server restarts and requires users to connect to the same API instance.
- Click **Run Java** to compile the workspace's Java files together and run the `Main` class, with optional standard input. A workspace can contain up to 20 files; each file is limited to 32 KB and a project to 128 KB. Compiler diagnostics, standard output, and runtime errors appear in the output panel.
- Install a JDK and make sure both `javac` and `java` are on `PATH`.
- The local runner limits source to 32 KB, compile time to 15 seconds, execution time to 8 seconds, Java heap to 128 MB, and output to 64 KB. It runs code as the same operating-system user as the backend; it is for local development with code you trust, **not** a secure sandbox for public or untrusted code.

Run frontend checks with:

```powershell
npm run lint
npm run build
```
