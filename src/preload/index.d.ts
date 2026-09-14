import type { FundarritariApi } from './index'

declare global {
  interface Window {
    fundarritari: FundarritariApi
  }
}
export {}
