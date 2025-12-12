declare module 'virtual:pwa-register/react' {
  import type { Dispatch, SetStateAction } from 'react'

  export interface RegisterSWOptions {
    immediate?: boolean
    onOfflineReady?: (registration: ServiceWorkerRegistration | undefined) => void
    onNeedRefresh?: (registration: ServiceWorkerRegistration | undefined) => void
    onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onRegisterError?: (error: any) => void
  }

  export interface UseRegisterSWReturn {
    offlineReady: [boolean, Dispatch<SetStateAction<boolean>>]
    needRefresh: [boolean, Dispatch<SetStateAction<boolean>>]
    updateServiceWorker: (reloadPage?: boolean) => Promise<void>
  }

  export function useRegisterSW(options?: RegisterSWOptions): UseRegisterSWReturn
}
