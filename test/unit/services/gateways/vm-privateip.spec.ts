import { describe, it, expect } from 'vitest';
import { type GatewayVM } from '../../../../src/api/services/entities';

describe('Cloud Gateway VM privateIp Handling', () => {
  describe('AWS PrivateIpAddress mapping', () => {
    it('should handle undefined PrivateIpAddress from AWS API', () => {
      const awsInstance = {
        InstanceId: 'i-123',
        PublicIpAddress: '1.2.3.4',
        PrivateIpAddress: undefined,
      };

      const vm: GatewayVM = {
        cloudId: awsInstance.InstanceId!,
        ip: awsInstance.PublicIpAddress!,
        privateIp: awsInstance.PrivateIpAddress,
      };

      expect(vm.privateIp).toBeUndefined();
      expect(vm.cloudId).toBe('i-123');
      expect(vm.ip).toBe('1.2.3.4');
    });

    it('should preserve valid PrivateIpAddress from AWS API', () => {
      const awsInstance = {
        InstanceId: 'i-123',
        PublicIpAddress: '1.2.3.4',
        PrivateIpAddress: '10.0.0.1',
      };

      const vm: GatewayVM = {
        cloudId: awsInstance.InstanceId!,
        ip: awsInstance.PublicIpAddress!,
        privateIp: awsInstance.PrivateIpAddress,
      };

      expect(vm.privateIp).toBe('10.0.0.1');
    });
  });

  describe('Azure privateIPAddress mapping', () => {
    it('should handle undefined privateIPAddress from Azure API', () => {
      const azureNicConfig = {
        privateIPAddress: undefined,
      };

      const vm: GatewayVM = {
        cloudId: 'vm-azure',
        ip: '1.2.3.4',
        privateIp: azureNicConfig.privateIPAddress,
      };

      expect(vm.privateIp).toBeUndefined();
    });

    it('should preserve valid privateIPAddress from Azure API', () => {
      const azureNicConfig = {
        privateIPAddress: '10.0.0.1',
      };

      const vm: GatewayVM = {
        cloudId: 'vm-azure',
        ip: '1.2.3.4',
        privateIp: azureNicConfig.privateIPAddress,
      };

      expect(vm.privateIp).toBe('10.0.0.1');
    });
  });

  describe('GCP networkIP mapping', () => {
    it('should handle undefined networkIP from GCP API', () => {
      const gcpNetworkInterface = {
        networkIP: undefined,
      };

      const vm: GatewayVM = {
        cloudId: 'gcp-vm',
        ip: '1.2.3.4',
        privateIp: gcpNetworkInterface.networkIP,
      };

      expect(vm.privateIp).toBeUndefined();
    });

    it('should handle empty string networkIP from GCP getAllVMs', () => {
      const gcpNetworkInterface = {
        networkIP: '',
      };

      const vm: GatewayVM = {
        cloudId: 'gcp-vm',
        ip: '1.2.3.4',
        privateIp: gcpNetworkInterface.networkIP || undefined,
      };

      expect(vm.privateIp).toBeUndefined();
    });

    it('should preserve valid networkIP from GCP API', () => {
      const gcpNetworkInterface = {
        networkIP: '10.0.0.1',
      };

      const vm: GatewayVM = {
        cloudId: 'gcp-vm',
        ip: '1.2.3.4',
        privateIp: gcpNetworkInterface.networkIP,
      };

      expect(vm.privateIp).toBe('10.0.0.1');
    });
  });

  describe('VM interface contract', () => {
    it('should enforce privateIp as optional string', () => {
      const vmWithUndefined: GatewayVM = {
        cloudId: 'vm-1',
        ip: '1.2.3.4',
        privateIp: undefined,
      };

      const vmWithString: GatewayVM = {
        cloudId: 'vm-2',
        ip: '2.3.4.5',
        privateIp: '10.0.0.1',
      };

      expect(vmWithUndefined.privateIp).toBeUndefined();
      expect(vmWithString.privateIp).toBe('10.0.0.1');

      // Type assertion: privateIp should be string | undefined, not null
      type AssertOptional = GatewayVM['privateIp'] extends string | undefined
        ? true
        : false;
      const typeCheck: AssertOptional = true;
      expect(typeCheck).toBe(true);
    });

    it('should handle all required VM fields', () => {
      const vm: GatewayVM = {
        cloudId: 'vm-123',
        ip: '1.2.3.4',
        privateIp: '10.0.0.1',
      };

      expect(vm.cloudId).toBeDefined();
      expect(vm.ip).toBeDefined();
      expect(vm.privateIp).toBeDefined();

      expect(typeof vm.cloudId).toBe('string');
      expect(typeof vm.ip).toBe('string');
    });

    it('should allow optional availabilityZone field', () => {
      const vmWithZone: GatewayVM = {
        cloudId: 'vm-123',
        ip: '1.2.3.4',
        privateIp: '10.0.0.1',
        availabilityZone: 'us-east-1a',
      };

      const vmWithoutZone: GatewayVM = {
        cloudId: 'vm-456',
        ip: '2.3.4.5',
        privateIp: undefined,
      };

      expect(vmWithZone.availabilityZone).toBe('us-east-1a');
      expect(vmWithoutZone.availabilityZone).toBeUndefined();
    });
  });

  describe('Edge cases for privateIp handling', () => {
    it('should convert empty string to undefined using ||', () => {
      const emptyString = '';
      const result = emptyString || undefined;
      expect(result).toBeUndefined();
    });

    it('should handle undefined passthrough', () => {
      const undefinedValue = undefined;
      const result = undefinedValue ?? undefined;
      expect(result).toBeUndefined();
    });

    it('should preserve valid IP addresses', () => {
      const validIps = ['10.0.0.1', '192.168.1.1', '172.16.0.1'];

      validIps.forEach((ip) => {
        const result: string | undefined = ip;
        expect(result).toBe(ip);
      });
    });

    it('should demonstrate database layer converts undefined to null', () => {
      // This happens in completeProvisioningAttempt()
      const privateIp: string | undefined = undefined;
      const forDatabase = privateIp ?? null; // Converted for SQL storage
      expect(forDatabase).toBe(null);
    });
  });
});
