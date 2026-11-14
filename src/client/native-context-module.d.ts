declare module 'dsh-gpt-adapter/native-context-settings' {
  export const nativeModelsRuntimes: ReadonlyArray<{
    expectedModelsSectionSource: string
    getComponent(): import('react').ComponentType<Record<string, unknown>>
  }>
}
