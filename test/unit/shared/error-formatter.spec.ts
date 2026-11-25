import { describe, it, expect } from 'vitest';
import {
  archMismatchGuidance,
  formatErrorForUser,
  isUserError,
} from '../../../src/shared/error-formatter.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { DeployError } from '../../../src/shared/errors.js';

describe('formatErrorForUser', () => {
  describe('String errors', () => {
    it('should return string errors as-is', () => {
      expect(formatErrorForUser('Connection timeout', null)).toBe(
        'Connection timeout',
      );
    });

    it('should handle empty string', () => {
      expect(formatErrorForUser('', null)).toBe('');
    });
  });

  describe('Null/undefined', () => {
    it('should handle null', () => {
      expect(formatErrorForUser(null, null)).toBe('Unknown error');
    });

    it('should handle undefined', () => {
      expect(formatErrorForUser(undefined, null)).toBe('Unknown error');
    });
  });

  describe('AWS errors', () => {
    it('should format AccessDenied with helpful message', () => {
      const error = {
        message: 'UnknownError',
        Code: 'AccessDenied',
        $fault: 'client',
        $metadata: { httpStatusCode: 403 },
      };
      expect(formatErrorForUser(error, CloudType.AWS)).toBe(
        'Access denied. Check your AWS credentials have required permissions.',
      );
    });

    it('should format InvalidClientTokenId', () => {
      const error = {
        message: 'The security token included in the request is invalid',
        Code: 'InvalidClientTokenId',
        $metadata: { httpStatusCode: 403 },
      };
      expect(formatErrorForUser(error, CloudType.AWS)).toBe(
        'Invalid AWS credentials. Check your access key ID.',
      );
    });

    it('should format InstanceLimitExceeded', () => {
      const error = {
        message: 'You have requested more instances than your current limit',
        Code: 'InstanceLimitExceeded',
        $metadata: { httpStatusCode: 400 },
      };
      expect(formatErrorForUser(error, CloudType.AWS)).toBe(
        'Instance limit exceeded. Request a quota increase or use a different region.',
      );
    });

    it('should format InsufficientInstanceCapacity', () => {
      const error = {
        message: 'We currently do not have sufficient capacity',
        Code: 'InsufficientInstanceCapacity',
        $metadata: { httpStatusCode: 500 },
      };
      expect(formatErrorForUser(error, CloudType.AWS)).toBe(
        'Insufficient capacity. Try a different instance type or region.',
      );
    });

    it('should show HTTP 301 with helpful message', () => {
      const error = {
        message: 'UnknownError',
        name: 'Unknown',
        $fault: 'client',
        $metadata: { httpStatusCode: 301 },
      };
      expect(formatErrorForUser(error, CloudType.AWS)).toBe(
        'Resource moved. This may indicate a region or configuration mismatch.',
      );
    });

    it('should format AWS errors with message and code (no JSON needed)', () => {
      // This is a real error from AWS SDK with lots of internal fields
      const error = {
        message: 'Throttling: Rate exceeded',
        Code: 'Throttling',
        Type: 'Sender',
        $fault: 'client',
        $retryable: undefined,
        $metadata: {
          httpStatusCode: 400,
          requestId: 'a158f8ae-0ed6-4a0c-8623-4e21aca0cec8',
          extendedRequestId: undefined,
          cfId: undefined,
          attempts: 3,
          totalRetryDelay: 871,
        },
        name: 'ThrottlingException',
      };

      const result = formatErrorForUser(error, CloudType.AWS);

      // Should show the message and code in natural language (no JSON needed)
      expect(result).toBe('Throttling: Rate exceeded (Throttling)');
    });

    it('should format unmapped AWS error with code but no special-casing', () => {
      const error = {
        message: 'Something unusual happened',
        Code: 'UnmappedErrorCode',
        $metadata: { httpStatusCode: 500 },
        // service-terminology-ok: AWS SDK owns this fault classification
        $fault: 'server',
      };

      const result = formatErrorForUser(error, CloudType.AWS);

      // Should show message with code in natural language
      expect(result).toBe('Something unusual happened (UnmappedErrorCode)');
    });

    it('should extract Type field from AWS errors when no other info available', () => {
      const error = {
        Type: 'Sender',
        $fault: 'client',
        $metadata: {},
      };

      const result = formatErrorForUser(error, CloudType.AWS);

      // Should show the Type field
      expect(result).toBe('AWS error (Type: Sender)');
    });

    it('should extract Error object from AWS errors', () => {
      const error = {
        Error: {
          Code: 'EntityAlreadyExists',
          Message: 'Role with name test-role already exists.',
        },
        $metadata: {},
      };

      const result = formatErrorForUser(error, CloudType.AWS);

      // Should extract from Error object
      expect(result).toBe(
        'Role with name test-role already exists. (EntityAlreadyExists)',
      );
    });
  });

  describe('Azure errors', () => {
    it('should format AuthorizationFailed', () => {
      const error = {
        message: 'The client does not have authorization to perform action',
        code: 'AuthorizationFailed',
        statusCode: 403,
      };
      expect(formatErrorForUser(error, CloudType.Azure)).toBe(
        'Access denied. Check your Azure credentials have required permissions.',
      );
    });

    it('should format InvalidAuthenticationToken', () => {
      const error = {
        message: 'Authentication failed',
        code: 'InvalidAuthenticationToken',
        statusCode: 401,
      };
      expect(formatErrorForUser(error, CloudType.Azure)).toBe(
        'Invalid Azure credentials. Check your authentication token.',
      );
    });

    it('should format QuotaExceeded', () => {
      const error = {
        message:
          'Operation could not be completed as it results in exceeding quota',
        code: 'QuotaExceeded',
        statusCode: 403,
      };
      expect(formatErrorForUser(error, CloudType.Azure)).toBe(
        'Quota exceeded. Request a quota increase or use a different region.',
      );
    });

    it('should format SkuNotAvailable', () => {
      const error = {
        message: 'The requested VM size is not available',
        code: 'SkuNotAvailable',
        statusCode: 409,
      };
      expect(formatErrorForUser(error, CloudType.Azure)).toBe(
        'VM size not available. Try a different size or region.',
      );
    });

    it('should format Azure errors with message and code (strips SDK internals)', () => {
      const error = {
        message: 'Resource allocation failed',
        code: 'UnknownCode',
        statusCode: 409,
        name: 'RestError',
        request: {
          url: 'https://management.azure.com/subscriptions/...',
          method: 'PUT',
          headers: { Authorization: 'Bearer token...' },
        },
        response: {
          statusCode: 409,
          headers: { 'x-ms-request-id': '12345-67890' },
        },
        stack: 'Error: Resource allocation failed\n    at ...',
      };

      const result = formatErrorForUser(error, CloudType.Azure);

      // Should show message with code (no JSON needed since we have message+code)
      expect(result).toBe('Resource allocation failed (UnknownCode)');
    });

    it('should extract nested error from error.error property', () => {
      const error = {
        statusCode: 400,
        error: {
          code: 'InvalidParameter',
          message: 'The parameter value is invalid',
        },
      };

      const result = formatErrorForUser(error, CloudType.Azure);

      // Should extract nested error
      expect(result).toBe('The parameter value is invalid (InvalidParameter)');
    });

    it('should extract nested error from body.error property', () => {
      const error = {
        statusCode: 404,
        body: {
          error: {
            Code: 'ResourceNotFound',
            Message: 'The resource was not found',
          },
        },
      };

      const result = formatErrorForUser(error, CloudType.Azure);

      // Should extract nested error from body
      expect(result).toBe('The resource was not found (ResourceNotFound)');
    });

    it('should extract nested error message from JSON string', () => {
      const error = {
        message:
          '{"Error":{"Details":[{"Message":"Rate limit exceeded for this region"}]}}',
        code: 'TooManyRequests',
        statusCode: 429,
      };

      const result = formatErrorForUser(error, CloudType.Azure);

      // Should extract the nested message from JSON
      expect(result).toContain('Rate limit exceeded');
      expect(result).toContain('TooManyRequests');
    });
  });

  describe('HTTP status fallbacks', () => {
    it('should use HTTP 403 fallback when no error code', () => {
      const error = {
        message: 'UnknownError',
        $metadata: { httpStatusCode: 403 },
      };
      expect(formatErrorForUser(error, CloudType.AWS)).toBe(
        'Access denied. Check your permissions.',
      );
    });

    it('should show message with HTTP status when both present', () => {
      const error = {
        message: 'Internal Server Error',
        $metadata: { httpStatusCode: 500 },
      };
      expect(formatErrorForUser(error, CloudType.AWS)).toBe(
        'Internal Server Error (HTTP 500)',
      );
    });

    it('replaces generic 400 fallback with opt-in hint for unparseable AWS error', () => {
      // Real shape from S3 against a not-opted-in region: SDK couldn't parse
      // the body so it threw name: "Unknown" / message: "UnknownError" with
      // no Code. The generic "Bad request. Check workload parameters."
      // is misleading — point at the actual cause instead.
      const error = {
        name: 'Unknown',
        message: 'UnknownError',
        $fault: 'client',
        $metadata: { httpStatusCode: 400, requestId: '733MDV2NBYHJ2T45' },
      };
      const result = formatErrorForUser(error, CloudType.AWS);
      expect(result).toContain('region not opted in');
      expect(result).toContain('733MDV2NBYHJ2T45');
      expect(result).not.toContain('Check workload parameters');
    });

    it('triggers opt-in hint when Code is UnknownError (matches classifyError)', () => {
      const error = {
        name: 'Error',
        Code: 'UnknownError',
        message: 'something else',
        $metadata: { httpStatusCode: 400 },
      };
      const result = formatErrorForUser(error, CloudType.AWS);
      expect(result).toContain('region not opted in');
    });

    it('does not trigger opt-in hint on bare message=UnknownError without matching Code/name', () => {
      // Without a matching Code or name, classifyError would not return
      // InvalidTarget — so the formatter must not promise rotation either.
      const error = {
        name: 'Error',
        message: 'UnknownError',
        $metadata: { httpStatusCode: 400 },
      };
      const result = formatErrorForUser(error, CloudType.AWS);
      expect(result).not.toContain('region not opted in');
      expect(result).toBe('Bad request. Check workload parameters.');
    });
  });

  describe('Fallback formatting', () => {
    it('should show message with error code when no mapping exists', () => {
      const error = {
        message: 'Something went wrong',
        Code: 'UnknownErrorCode',
      };
      expect(formatErrorForUser(error, CloudType.AWS)).toBe(
        'Something went wrong (UnknownErrorCode)',
      );
    });

    it('should show message with HTTP status when no code', () => {
      const error = {
        message: 'Request failed',
        $metadata: { httpStatusCode: 418 },
      };
      expect(formatErrorForUser(error, CloudType.AWS)).toBe(
        'Request failed (HTTP 418)',
      );
    });

    it('should skip "UnknownError" message and show code only', () => {
      const error = {
        message: 'UnknownError',
        Code: 'SomeSpecificCode',
      };
      expect(formatErrorForUser(error, CloudType.AWS)).toBe('SomeSpecificCode');
    });

    it('should handle error with only HTTP status', () => {
      const error = {
        $metadata: { httpStatusCode: 404 },
      };
      expect(formatErrorForUser(error, CloudType.AWS)).toBe(
        'Resource not found.',
      );
    });
  });

  describe('Container errors', () => {
    it('should show container logs when available', () => {
      const error = {
        message: 'Command exited with code 7:',
        exitCode: 7,
        logs: 'ERROR: Failed to copy: AccessDenied: Access Denied\nTransferred: 0 / 0 Bytes',
      };
      const result = formatErrorForUser(error, CloudType.AWS);
      expect(result).toContain('AccessDenied');
      expect(result).not.toContain('Command exited');
    });

    it('should fall back to message if logs are empty', () => {
      const error = {
        message: 'Container failed to start',
        logs: '',
      };
      expect(formatErrorForUser(error, CloudType.AWS)).toBe(
        'Container failed to start',
      );
    });

    it('should handle missing logs field', () => {
      const error = {
        message: 'Something went wrong',
        exitCode: 1,
      };
      expect(formatErrorForUser(error, CloudType.AWS)).toBe(
        'Something went wrong',
      );
    });

    it('should prioritize logs over generic message', () => {
      const error = {
        message: 'UnknownError',
        logs: 'Actual detailed error from container stderr',
      };
      expect(formatErrorForUser(error, CloudType.AWS)).toBe(
        '[Errors in last 100 lines - may not be fatal]\nActual detailed error from container stderr',
      );
    });
  });

  describe('AWS Spot instance errors', () => {
    it('should format SpotMaxPriceTooLow', () => {
      const error = {
        message: 'Your Spot request price is lower than the minimum',
        Code: 'SpotMaxPriceTooLow',
        $metadata: { httpStatusCode: 400 },
      };
      expect(formatErrorForUser(error, CloudType.AWS)).toBe(
        'Spot bid too low. Increase max price or use on-demand instances.',
      );
    });

    it('should format InsufficientSpotCapacity', () => {
      const error = {
        message: 'There is no Spot capacity available',
        Code: 'InsufficientSpotCapacity',
        $metadata: { httpStatusCode: 500 },
      };
      expect(formatErrorForUser(error, CloudType.AWS)).toBe(
        'No spot capacity available. Try a different instance type or region.',
      );
    });

    it('should format SpotInstanceCountExceeded', () => {
      const error = {
        message: 'Spot instance count limit exceeded',
        Code: 'SpotInstanceCountExceeded',
        $metadata: { httpStatusCode: 400 },
      };
      expect(formatErrorForUser(error, CloudType.AWS)).toBe(
        'Spot instance limit exceeded. Request quota increase or reduce spot instances.',
      );
    });
  });

  describe('AWS Marketplace errors', () => {
    it('should format MarketplacePurchaseEligibilityFailed', () => {
      const error = {
        message: 'You are not authorized to purchase from AWS Marketplace',
        Code: 'MarketplacePurchaseEligibilityFailed',
        $metadata: { httpStatusCode: 403 },
      };
      expect(formatErrorForUser(error, CloudType.AWS)).toBe(
        'AWS Marketplace terms not accepted. Visit AWS Marketplace to accept terms for this AMI.',
      );
    });

    it('should format OptInRequired', () => {
      const error = {
        message: 'You need to opt in to use this product',
        Code: 'OptInRequired',
        $metadata: { httpStatusCode: 403 },
      };
      expect(formatErrorForUser(error, CloudType.AWS)).toBe(
        'Marketplace subscription required. Subscribe to this product in AWS Marketplace.',
      );
    });
  });

  describe('Azure storage errors', () => {
    it('should format StorageAccountAlreadyExists', () => {
      const error = {
        message:
          'The storage account named X is already taken globally across Azure',
        code: 'StorageAccountAlreadyExists',
        statusCode: 409,
      };
      expect(formatErrorForUser(error, CloudType.Azure)).toBe(
        'Storage account name already taken globally.',
      );
    });

    it('should format InvalidStorageAccountName', () => {
      const error = {
        message: 'The storage account name is invalid',
        code: 'InvalidStorageAccountName',
        statusCode: 400,
      };
      expect(formatErrorForUser(error, CloudType.Azure)).toBe(
        'Invalid storage account name. Check Azure naming requirements.',
      );
    });

    it('should format ContainerNotFound', () => {
      const error = {
        message: 'The specified container does not exist',
        code: 'ContainerNotFound',
        statusCode: 404,
      };
      expect(formatErrorForUser(error, CloudType.Azure)).toBe(
        'Storage container not found.',
      );
    });
  });

  describe('Azure network errors', () => {
    it('should format NetworkInterfaceNotFound', () => {
      const error = {
        message: 'Network interface not found',
        code: 'NetworkInterfaceNotFound',
        statusCode: 404,
      };
      expect(formatErrorForUser(error, CloudType.Azure)).toBe(
        'Network interface not found.',
      );
    });

    it('should format PublicIPAddressNotFound', () => {
      const error = {
        message: 'Public IP address not found',
        code: 'PublicIPAddressNotFound',
        statusCode: 404,
      };
      expect(formatErrorForUser(error, CloudType.Azure)).toBe(
        'Public IP address not found.',
      );
    });

    it('should format VirtualNetworkNotFound', () => {
      const error = {
        message: 'Virtual network not found',
        code: 'VirtualNetworkNotFound',
        statusCode: 404,
      };
      expect(formatErrorForUser(error, CloudType.Azure)).toBe(
        'Virtual network not found.',
      );
    });
  });

  describe('GCP errors', () => {
    it('should format PERMISSION_DENIED', () => {
      const error = {
        message: 'Permission denied on resource project',
        name: 'PERMISSION_DENIED',
      };
      expect(formatErrorForUser(error, CloudType.GCP)).toBe(
        'Access denied. Check your GCP credentials have required permissions.',
      );
    });

    it('should format RESOURCE_EXHAUSTED', () => {
      const error = {
        message: 'Quota exceeded for quota metric',
        name: 'RESOURCE_EXHAUSTED',
      };
      expect(formatErrorForUser(error, CloudType.GCP)).toBe(
        'GCP quota exceeded. Request quota increase.',
      );
    });

    it('should format INVALID_ARGUMENT', () => {
      const error = {
        message: 'Invalid value for field',
        name: 'INVALID_ARGUMENT',
      };
      expect(formatErrorForUser(error, CloudType.GCP)).toBe(
        'Invalid parameter. Check your request parameters.',
      );
    });

    it('should format NOT_FOUND', () => {
      const error = {
        message: 'Resource not found',
        name: 'NOT_FOUND',
      };
      expect(formatErrorForUser(error, CloudType.GCP)).toBe(
        'GCP resource not found.',
      );
    });

    it('should format UNAVAILABLE', () => {
      const error = {
        message: 'The service is currently unavailable',
        name: 'UNAVAILABLE',
      };
      expect(formatErrorForUser(error, CloudType.GCP)).toBe(
        'GCP service unavailable. Try again in a few moments.',
      );
    });

    it('should show unmapped GCP error with name in fallback', () => {
      const error = {
        message: 'Something went wrong',
        name: 'DEADLINE_EXCEEDED',
      };
      expect(formatErrorForUser(error, CloudType.GCP)).toBe(
        'Something went wrong (DEADLINE_EXCEEDED)',
      );
    });

    it('should format GCP 412 precondition failed (extracts from errors array)', () => {
      // This is the actual error from production when concurrent workloads
      // try to update the same bucket's IAM policy simultaneously
      const error = {
        message:
          'Failed to grant GCS bucket access for VM test-vm-0: At least one of the pre-conditions you specified did not hold.',
        name: 'Error',
        code: 412,
        errors: [
          {
            message:
              'At least one of the pre-conditions you specified did not hold.',
            domain: 'global',
            reason: 'conditionNotMet',
            locationType: 'header',
            location: 'If-Match',
          },
        ],
        response: {
          statusCode: 412,
          statusMessage: 'Precondition Failed',
          headers: {
            'alt-svc': 'h3=":443"; ma=2592000,h3-29=":443"; ma=2592000',
            'x-guploader-uploadid':
              'AHVrFxP6E_wS0BMJlGdsQAMxMn1RebD36HwxSxLB3OekqDAlRcDDe9Vt3iO4xnmcr_1A23lL',
          },
        },
      };

      const result = formatErrorForUser(error, CloudType.GCP);

      // Should extract from errors array (prioritized over top-level message)
      expect(result).toBe(
        'At least one of the pre-conditions you specified did not hold. (reason: conditionNotMet)',
      );
    });

    it('should extract error details from GCP errors array', () => {
      const error = {
        code: 400,
        errors: [
          {
            message: 'Invalid bucket name: contains invalid characters',
            reason: 'invalid',
          },
        ],
      };

      const result = formatErrorForUser(error, CloudType.GCP);

      // Should extract from errors array
      expect(result).toBe(
        'Invalid bucket name: contains invalid characters (reason: invalid)',
      );
    });

    it('should extract error details from GCP details array', () => {
      const error = {
        code: 429,
        details: ['Rate limit exceeded. Please slow down.'],
      };

      const result = formatErrorForUser(error, CloudType.GCP);

      // Should extract from details array
      expect(result).toBe('Rate limit exceeded. Please slow down.');
    });

    it('should extract from GCP errors array (priority over message)', () => {
      const error = {
        message: 'Service temporarily unavailable',
        name: 'UnknownError',
        code: 503,
        errors: [{ message: 'Backend service error', domain: 'global' }],
        response: {
          statusCode: 503,
          headers: { 'x-request-id': 'abc123' },
        },
      };

      const result = formatErrorForUser(error, CloudType.GCP);

      // Should extract from errors array (prioritized over top-level message)
      expect(result).toBe('Backend service error');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty object', () => {
      expect(formatErrorForUser({}, null)).toBe('Unknown error');
    });

    it('surfaces the message for clouds without a dedicated formatter', () => {
      expect(formatErrorForUser({ message: 'boom' }, CloudType.Lambda)).toBe(
        'boom',
      );
    });

    it('surfaces the message when the cloud is unknown (null)', () => {
      expect(formatErrorForUser({ message: 'boom' }, null)).toBe('boom');
      expect(formatErrorForUser({}, null)).toBe('Unknown error');
    });

    it('should output JSON as last resort when no useful fields found', () => {
      const error = { foo: 'bar', baz: 123 };
      const result = formatErrorForUser(error, CloudType.AWS);
      // Should show JSON as last resort (better than just "AWS error")
      expect(result).toContain('"foo": "bar"');
      expect(result).toContain('"baz": 123');
    });

    it('should output cleaned JSON for unrecognized errors (strips SDK internals)', () => {
      const weirdError = {
        someField: 'value',
        nested: { deep: { object: 'here' } },
        array: [1, 2, 3],
        $metadata: { should: 'be stripped' }, // AWS internal
        request: { should: 'be stripped' }, // Azure internal
        response: { should: 'be stripped' }, // GCP/Azure internal
      };

      // Test AWS (strips $metadata)
      const awsResult = formatErrorForUser(weirdError, CloudType.AWS);
      expect(awsResult).toContain('someField');
      expect(awsResult).not.toContain('$metadata');

      // Test Azure (strips request/response)
      const azureResult = formatErrorForUser(weirdError, CloudType.Azure);
      expect(azureResult).toContain('someField');
      expect(azureResult).not.toContain('request');
      expect(azureResult).not.toContain('response');

      // Test GCP (strips response)
      const gcpResult = formatErrorForUser(weirdError, CloudType.GCP);
      expect(gcpResult).toContain('someField');
      expect(gcpResult).not.toContain('response');
    });
  });
});

describe('isUserError', () => {
  describe('DeployError with statusCode < 500', () => {
    it('returns true for 400-level DeployError', () => {
      expect(isUserError(new DeployError('bad input', 400))).toBe(true);
    });

    it('returns true for 404 DeployError', () => {
      expect(isUserError(new DeployError('not found', 404))).toBe(true);
    });

    it('returns false for 500-level DeployError', () => {
      expect(isUserError(new DeployError('server error', 500))).toBe(false);
    });
  });

  describe('Non-user errors', () => {
    it('returns false for generic Error', () => {
      expect(isUserError(new Error('SSH timeout'))).toBe(false);
    });

    it('returns false for plain Error with no statusCode', () => {
      expect(isUserError(new Error('something broke'))).toBe(false);
    });

    it('returns false for null', () => {
      expect(isUserError(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isUserError(undefined)).toBe(false);
    });
  });
});

describe('archMismatchGuidance', () => {
  // The exact Docker wording differs by version and image shape — match each
  // known variant. (Captured from real `docker pull --platform linux/amd64`
  // failures.)
  const VARIANTS = [
    'no matching manifest for linux/amd64 in the manifest list entries: no match for platform in manifest: not found',
    'image with reference ghcr.io/x/y was found but its platform (linux/arm64) does not match the specified platform (linux/amd64)',
    'no match for platform in manifest: not found',
  ];

  for (const stderr of VARIANTS) {
    it(`returns rebuild guidance for: "${stderr.slice(0, 40)}…"`, () => {
      const out = archMismatchGuidance(stderr, 'ghcr.io/x/y:latest');
      expect(out).not.toBeNull();
      expect(out).toContain('linux/amd64');
      expect(out).toContain('buildx');
      expect(out).toContain('ghcr.io/x/y:latest');
    });
  }

  it('names linux/arm64 when an arm64 host found no build for it', () => {
    const out = archMismatchGuidance(
      'no matching manifest for linux/arm64/v8 in the manifest list entries',
      'ghcr.io/x/y:latest',
      'arm64',
    );
    expect(out).toContain('has no linux/arm64 build');
    expect(out).toContain('--platform linux/arm64');
  });

  it('falls back to "This image"/IMAGE when no image is given', () => {
    const out = archMismatchGuidance('no matching manifest for linux/amd64');
    expect(out).toContain('This image');
    expect(out).toContain('-t IMAGE --push');
  });

  it('returns null for a non-arch error', () => {
    expect(
      archMismatchGuidance('Error response from daemon: manifest unknown'),
    ).toBeNull();
    expect(
      archMismatchGuidance('unauthorized: authentication required'),
    ).toBeNull();
  });
});
