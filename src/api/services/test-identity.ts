/** GitHub identities reserved for the API's explicit test-authentication mode. */
export const TEST_USERNAMES = ['anycloud-test'] as const;
export const TEST_USER_ID = '1';

export function isTestStubUser(userId: string | undefined | null): boolean {
  return !!userId && (TEST_USERNAMES as readonly string[]).includes(userId);
}
