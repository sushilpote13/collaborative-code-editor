export function isAlreadyAuthenticatedError(error) {
  return error?.name === 'UserAlreadyAuthenticatedException';
}

export async function signInWithSessionRecovery({
  account,
  password,
  signIn,
  clearExistingSession,
}) {
  try {
    return await signIn(account, password);
  } catch (error) {
    if (!isAlreadyAuthenticatedError(error)) {
      throw error;
    }
    await clearExistingSession();
    return signIn(account, password);
  }
}
