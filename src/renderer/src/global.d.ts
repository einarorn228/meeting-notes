import type { FundarritariApi } from '../../preload/index'

declare global {
  interface Window {
    fundarritari: FundarritariApi
  }
}
export {}
