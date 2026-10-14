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

5. Run the backend and frontend in separate terminals from this directory:

   ```powershell
   npm run dev:api
   ```

   ```powershell
   npm run dev
   ```

The API listens on port `3001`, and Vite proxies `/api` requests to that port.

If the browser reports `502` for an `/api` request, the Vite proxy cannot reach the auth API. Start `npm run dev:api` in a second terminal and confirm the terminal says it connected to MongoDB and is listening on port `3001`.

## Login and signup flow

- The app first shows the login form and checks the email/password against MongoDB.
- If no account exists for the email, it switches to signup and keeps the email entered.
- Signup stores names, a unique normalized username, and a normalized email in MongoDB. Usernames use 3-20 letters, numbers, or underscores and start with a letter. Passwords are bcrypt-hashed before storage.
- Login and signup set a short-lived, HTTP-only authentication cookie. The editor route verifies the cookie; use **Log out** to clear it.
- The database and `users` collection are created by MongoDB/Mongoose when the first account is stored. Passwords are never logged or returned to the browser.

## Java editor

- The authenticated editor opens `Main.java` with Java syntax highlighting. Close the tab with `×`; reopen it from the project explorer.
- Click **Run Java** to send the source and optional standard input to the local backend. The backend compiles it with `javac` and runs its `Main` class; compiler diagnostics, standard output, and runtime errors appear in the output panel.
- Install a JDK and make sure both `javac` and `java` are on `PATH`.
- The local runner limits source to 32 KB, compile time to 15 seconds, execution time to 8 seconds, Java heap to 128 MB, and output to 64 KB. It runs code as the same operating-system user as the backend; it is for local development with code you trust, **not** a secure sandbox for public or untrusted code.

Run frontend checks with:

```powershell
npm run lint
npm run build
```
