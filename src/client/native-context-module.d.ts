declare module 'dsh-gpt-adapter/native-context-settings' {
  export const nativeModelsRuntimes: ReadonlyArray<{
    versions: readonly string[]
    factorySha256: string
    expectedModelsSectionSource: string
    getComponent(): import('react').ComponentType<Record<string, unknown>>
  }>
}
