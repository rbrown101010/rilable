import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.forge.poc',
  appName: 'Forge POC',
  webDir: 'www',
  server: {
    url: 'https://3000-ef695e2b-640a-4e19-87e9-27c6a455a3f8.daytonaproxy01.net',
    cleartext: false,
  },
};

export default config;
