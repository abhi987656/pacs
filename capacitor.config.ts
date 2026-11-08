import type { CapacitorConfig } from '@capacitor/cli'

// The Android companion app ("Personal PACS" on the phone). Its screens are built from src/mobile.
const config: CapacitorConfig = {
  appId: 'com.personalpacs.mobile',
  appName: 'Personal PACS',
  webDir: 'out-mobile',
  backgroundColor: '#000000',
  android: {
    backgroundColor: '#000000',
    // Release builds: no remote debugging of the app's screens.
    webContentsDebuggingEnabled: false
  },
  plugins: {
    SystemBars: {
      insetsHandling: 'css',
      style: 'DARK',
      initialViewportFitValueHint: 'cover'
    }
  }
}

export default config
