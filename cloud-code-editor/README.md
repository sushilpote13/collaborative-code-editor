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

Run frontend checks with:

```powershell
npm run lint
npm run build
```
