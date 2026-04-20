import { styleText } from 'node:util';
import CLITable from 'cli-table3';
import _ from 'lodash/fp';

import type { Core } from '@strapi/types';

export const createStartupLogger = (app: Core.Strapi) => {
  return {
    logStats() {
      const columns = Math.min(process.stderr.columns, 80) - 2;
      console.log();
      console.log(styleText(['black', 'bgWhite'], _.padEnd(columns, ' Project information')));
      console.log();

      const infoTable = new CLITable({
        colWidths: [20, 50],
        chars: { mid: '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' },
      });

      const dbInfo = app.db?.getInfo();

      infoTable.push(
        [styleText('blue', 'Time'), `${new Date()}`],
        [styleText('blue', 'Launched in'), `${Date.now() - app.config.launchedAt} ms`],
        [styleText('blue', 'Environment'), app.config.environment],
        [styleText('blue', 'Process PID'), process.pid],
        [styleText('blue', 'Version'), `${app.config.info.strapi} (node ${process.version})`],
        [styleText('blue', 'Edition'), app.EE ? 'Enterprise' : 'Community'],
        [styleText('blue', 'Database'), dbInfo?.client],
        [styleText('blue', 'Database name'), dbInfo?.displayName]
      );

      if (dbInfo?.schema) {
        infoTable.push([styleText('blue', 'Database schema'), dbInfo.schema]);
      }

      console.log(infoTable.toString());
      console.log();
      console.log(styleText(['black', 'bgWhite'], _.padEnd(columns, ' Actions available')));
      console.log();
    },

    logFirstStartupMessage() {
      if (!strapi.config.get('server.logger.startup.enabled')) {
        return;
      }

      this.logStats();

      console.log(styleText('bold', 'One more thing...'));
      console.log(
        styleText(
          'grey',
          'Create your first administrator 💻 by going to the administration panel at:'
        )
      );
      console.log();

      const addressTable = new CLITable();

      const adminUrl = strapi.config.get('admin.absoluteUrl');
      addressTable.push([styleText('bold', String(adminUrl))]);

      console.log(`${addressTable.toString()}`);
      console.log();
    },

    logDefaultStartupMessage() {
      if (!strapi.config.get('server.logger.startup.enabled')) {
        return;
      }
      this.logStats();

      console.log(styleText('bold', 'Welcome back!'));

      if (app.config.get('admin.serveAdminPanel') === true) {
        console.log(
          styleText('grey', 'To manage your project 🚀, go to the administration panel at:')
        );
        const adminUrl = strapi.config.get('admin.absoluteUrl');
        console.log(styleText('bold', String(adminUrl)));
        console.log();
      }

      console.log(styleText('grey', 'To access the server ⚡️, go to:'));
      const serverUrl = strapi.config.get('server.absoluteUrl');
      console.log(styleText('bold', String(serverUrl)));
      console.log();
    },

    logStartupMessage({ isInitialized }: { isInitialized: boolean }) {
      if (!strapi.config.get('server.logger.startup.enabled')) {
        return;
      }
      if (!isInitialized) {
        this.logFirstStartupMessage();
      } else {
        this.logDefaultStartupMessage();
      }
    },
  };
};
