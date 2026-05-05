import { SETTINGS_LINKS_CE } from '../constants';
import { ROUTES_CE } from '../pages/Settings/constants';

import type { BrowserStrapi } from '../types/browserStrapi';

const setWindowStrapi = (adminTokensEnabled: boolean) => {
  const browserStrapi: BrowserStrapi = {
    isTrial: false,
    isTrialLicense: false,
    backendURL: '',
    isEE: false,
    telemetryDisabled: false,
    projectType: 'Community',
    ai: {
      enabled: false,
    },
    future: {
      isEnabled: jest.fn((featureName: string) => {
        return featureName === 'adminTokens' ? adminTokensEnabled : false;
      }),
    },
    features: {
      SSO: 'sso',
      AUDIT_LOGS: 'audit-logs',
      isEnabled: jest.fn(() => false),
      REVIEW_WORKFLOWS: 'review-workflows',
    },
    flags: {
      promoteEE: false,
    },
  };

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - conflicting node Strapi with window BrowserStrapi
  window.strapi = browserStrapi;
};

describe('adminTokens future flag', () => {
  afterEach(() => {
    // @ts-expect-error - window.strapi is not optional
    delete window.strapi;
  });

  test('removes the Admin Tokens settings link when disabled', () => {
    setWindowStrapi(false);

    const adminLinks = SETTINGS_LINKS_CE().admin;

    expect(adminLinks.some((link) => link.id === 'admin-tokens')).toBe(false);
  });

  test('keeps the Admin Tokens settings link when enabled', () => {
    setWindowStrapi(true);

    const adminLinks = SETTINGS_LINKS_CE().admin;

    expect(adminLinks.some((link) => link.id === 'admin-tokens')).toBe(true);
  });

  test('removes Admin Tokens settings routes when disabled', () => {
    setWindowStrapi(false);

    const routePaths = ROUTES_CE().map((route) => route.path);

    expect(routePaths).not.toContain('admin-tokens');
    expect(routePaths).not.toContain('admin-tokens/create');
    expect(routePaths).not.toContain('admin-tokens/:id');
  });

  test('keeps Admin Tokens settings routes when enabled', () => {
    setWindowStrapi(true);

    const routePaths = ROUTES_CE().map((route) => route.path);

    expect(routePaths).toContain('admin-tokens');
    expect(routePaths).toContain('admin-tokens/create');
    expect(routePaths).toContain('admin-tokens/:id');
  });
});
