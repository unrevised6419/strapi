import path from 'path';

import { getDirs } from '../get-dirs';

const appDir = path.resolve('/app');
const distDir = path.resolve('/app/dist');

const serverConfig = (dirs: { admin?: string; adminSrc?: string } = {}) => ({
  server: { dirs: { public: './public', ...dirs } },
});

describe('getDirs', () => {
  it('defaults the admin directories to src/admin', () => {
    const dirs = getDirs({ appDir, distDir }, serverConfig());

    expect(dirs.app.admin).toBe(path.join(appDir, 'src', 'admin'));
    expect(dirs.app.adminSrc).toBe(path.join(appDir, 'src', 'admin'));
  });

  it('resolves a relative server.dirs.admin from the app directory', () => {
    const dirs = getDirs({ appDir, distDir }, serverConfig({ admin: './admin' }));

    expect(dirs.app.admin).toBe(path.join(appDir, 'admin'));
  });

  it('keeps an absolute server.dirs.admin as is', () => {
    const adminDir = path.resolve('/elsewhere/admin');
    const dirs = getDirs({ appDir, distDir }, serverConfig({ admin: adminDir }));

    expect(dirs.app.admin).toBe(adminDir);
  });

  it('defaults server.dirs.adminSrc to the resolved admin directory', () => {
    const dirs = getDirs({ appDir, distDir }, serverConfig({ admin: './admin' }));

    expect(dirs.app.adminSrc).toBe(path.join(appDir, 'admin'));
  });

  it('resolves server.dirs.adminSrc independently from server.dirs.admin', () => {
    const dirs = getDirs(
      { appDir, distDir },
      serverConfig({ admin: './admin', adminSrc: './admin/src' })
    );

    expect(dirs.app.admin).toBe(path.join(appDir, 'admin'));
    expect(dirs.app.adminSrc).toBe(path.join(appDir, 'admin', 'src'));
  });

  it('allows setting only server.dirs.adminSrc', () => {
    const dirs = getDirs({ appDir, distDir }, serverConfig({ adminSrc: './admin-src' }));

    expect(dirs.app.admin).toBe(path.join(appDir, 'src', 'admin'));
    expect(dirs.app.adminSrc).toBe(path.join(appDir, 'admin-src'));
  });
});
