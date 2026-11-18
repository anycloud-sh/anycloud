import { describe, it, expect } from 'vitest';
import {
  AZURE_CUDA_COMMUNITY_IMAGE_ID,
  AZURE_CUDA_PROPRIETARY_COMMUNITY_IMAGE_ID,
  AZURE_GRID_COMMUNITY_IMAGE_ID,
  requiresProprietaryNvidiaModules,
  selectAzureGpuImageId,
} from '../../../../src/shared/catalog/azure-gpu-map';

describe('requiresProprietaryNvidiaModules', () => {
  it('is true for pre-Turing NVIDIA GPUs (incl. the V100-32GB catalog label)', () => {
    for (const name of [
      'V100',
      'V100-32GB',
      'P100',
      'P40',
      'P4',
      'M60',
      'M40',
      'M4',
      'K80',
      'K40',
      'K20',
    ]) {
      expect(requiresProprietaryNvidiaModules(name)).toBe(true);
    }
  });

  it('is false for Turing-and-newer GPUs', () => {
    for (const name of ['T4', 'A10', 'A100', 'A100-80GB', 'H100', 'H200']) {
      expect(requiresProprietaryNvidiaModules(name)).toBe(false);
    }
  });

  it('is case- and whitespace-insensitive', () => {
    expect(requiresProprietaryNvidiaModules('  v100  ')).toBe(true);
    expect(requiresProprietaryNvidiaModules('v100-32GB')).toBe(true);
  });
});

describe('selectAzureGpuImageId', () => {
  it('routes NV-series to GRID regardless of accelerator name', () => {
    expect(selectAzureGpuImageId('Standard_NV6ads_A10_v5', 'A10')).toBe(
      AZURE_GRID_COMMUNITY_IMAGE_ID,
    );
    // NV-series wins even if the accelerator would otherwise be proprietary.
    expect(selectAzureGpuImageId('Standard_NV12s_v3', 'M60')).toBe(
      AZURE_GRID_COMMUNITY_IMAGE_ID,
    );
  });

  it('routes pre-Turing NC/ND (V100, incl. V100-32GB) to the proprietary 0.10 image', () => {
    expect(selectAzureGpuImageId('Standard_NC6s_v3', 'V100')).toBe(
      AZURE_CUDA_PROPRIETARY_COMMUNITY_IMAGE_ID,
    );
    expect(selectAzureGpuImageId('Standard_ND40rs_v2', 'V100-32GB')).toBe(
      AZURE_CUDA_PROPRIETARY_COMMUNITY_IMAGE_ID,
    );
  });

  it('routes Turing+ NC/ND to the open-modules 0.14 image', () => {
    expect(selectAzureGpuImageId('Standard_NC4as_T4_v3', 'T4')).toBe(
      AZURE_CUDA_COMMUNITY_IMAGE_ID,
    );
    expect(selectAzureGpuImageId('Standard_NC40ads_H100_v5', 'H100')).toBe(
      AZURE_CUDA_COMMUNITY_IMAGE_ID,
    );
  });

  it('returns null for an NC/ND CUDA target with no resolvable accelerator name', () => {
    expect(selectAzureGpuImageId('Standard_NC_unknown', undefined)).toBeNull();
    expect(selectAzureGpuImageId('Standard_ND_unknown', null)).toBeNull();
    expect(selectAzureGpuImageId('Standard_NC_unknown', '  ')).toBeNull();
  });
});
