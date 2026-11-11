// Messages between the report editor and the spell-check worker.

export type SpellLang = 'en-GB' | 'en-US'

export type SpellRequest =
  | { type: 'init'; langs: SpellLang[]; words: string[] }
  | { type: 'check'; id: number; words: string[] }
  | { type: 'suggest'; id: number; word: string }
  | { type: 'add'; word: string }
  | { type: 'remove'; word: string }

export type SpellResponse =
  | { type: 'checked'; id: number; words: string[]; wrong: string[] }
  | { type: 'suggested'; id: number; suggestions: string[] }

/** Settings value -> dictionaries. */
export function spellLangs(setting: string): SpellLang[] {
  if (setting === 'en-GB') return ['en-GB']
  if (setting === 'en-US') return ['en-US']
  return ['en-GB', 'en-US']
}
