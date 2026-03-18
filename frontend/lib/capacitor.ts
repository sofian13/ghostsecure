import { Capacitor } from '@capacitor/core';

/** True when running inside the native iOS app (not the browser) */
export const isNativeApp = Capacitor.isNativePlatform();

/** Current platform: 'ios' | 'android' | 'web' */
export const platform = Capacitor.getPlatform();
