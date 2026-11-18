const GENERATED_RESOURCE_PREFIX = 'anycloud-';
const AZURE_RESOURCE_NAME_MAX_LENGTH = 256;

function getMaxCredentialNameLength(resourceNameMaxLength: number): number {
  return resourceNameMaxLength - GENERATED_RESOURCE_PREFIX.length;
}

export function validateGeneratedAzureCredentialName(
  credentialName: string,
): void {
  const resourceName = `${GENERATED_RESOURCE_PREFIX}${credentialName}`;
  if (
    credentialName.length >
      getMaxCredentialNameLength(AZURE_RESOURCE_NAME_MAX_LENGTH) ||
    [...resourceName].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error(
      `Credential name "${credentialName}" cannot be used for an Azure application. ` +
        'The generated display name must be at most 256 characters and contain no control characters.',
    );
  }
}
