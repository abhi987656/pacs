// One spell checker for the window: talks to the worker, caches answers, and tells the editors
// when new answers arrive so they can update their underlines.

import type { SpellLang, SpellRequest, SpellResponse } from './protocol'

type Listener = () => void

class Speller {
  enabled = false
  private worker: Worker | null = null
  private langs: SpellLang[] = []
  /** word -> misspelled? */
  private known = new Map<string, boolean>()
  private queued = new Set<string>()
  private asked = new Set<string>()
  /** "Ignore All" – for this session only, like Word. */
  private ignored = new Set<string>()
  private listeners = new Set<Listener>()
  private suggestWaits = new Map<number, (s: string[]) => void>()
  private personal = new Set<string>()
  private nextId = 1
  private flushTimer = 0
  private emitTimer = 0

  configure(opts: { enabled: boolean; langs: SpellLang[]; words: string[] }): void {
    const langsChanged = opts.langs.join() !== this.langs.join()
    this.enabled = opts.enabled
    this.langs = opts.langs
    if (opts.enabled && (!this.worker || langsChanged)) {
      if (!this.worker) {
        this.worker = new Worker(new URL('./spellWorker.ts', import.meta.url), { type: 'module' })
        this.worker.onmessage = (e: MessageEvent<SpellResponse>) => this.onMessage(e.data)
      }
      this.post({ type: 'init', langs: opts.langs, words: opts.words })
      this.personal = new Set(opts.words)
      this.known.clear()
      this.asked.clear()
    }
    this.emit()
  }

  /** The personal word list changed (added here, in a text box, or removed in Settings). */
  syncWords(words: string[]): void {
    const next = new Set(words)
    for (const w of next) if (!this.personal.has(w)) this.add(w)
    for (const w of this.personal) if (!next.has(w)) this.remove(w)
    this.personal = next
  }

  /** true = misspelled, false = fine, undefined = being checked (listeners hear when it's known). */
  isWrong(word: string): boolean | undefined {
    if (!this.enabled || this.ignored.has(word.toLowerCase())) return false
    const k = this.known.get(word)
    if (k !== undefined) return k
    if (!this.asked.has(word)) {
      this.queued.add(word)
      if (!this.flushTimer) this.flushTimer = window.setTimeout(() => this.flush(), 0)
    }
    return undefined
  }

  suggest(word: string): Promise<string[]> {
    if (!this.worker) return Promise.resolve([])
    const id = this.nextId++
    return new Promise((resolve) => {
      this.suggestWaits.set(id, resolve)
      this.post({ type: 'suggest', id, word })
    })
  }

  ignore(word: string): void {
    this.ignored.add(word.toLowerCase())
    this.emit()
  }

  /** Accepts the word from now on (the caller stores it in the personal dictionary). */
  add(word: string): void {
    this.personal.add(word)
    for (const k of this.known.keys()) if (k.toLowerCase() === word.toLowerCase()) this.known.set(k, false)
    this.known.set(word, false)
    this.post({ type: 'add', word })
    this.emit()
  }

  remove(word: string): void {
    this.post({ type: 'remove', word })
    this.known.clear()
    this.asked.clear()
    this.emit()
  }

  onChange(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private flush(): void {
    this.flushTimer = 0
    if (!this.worker || !this.queued.size) return
    const words = [...this.queued]
    this.queued.clear()
    for (const w of words) this.asked.add(w)
    this.post({ type: 'check', id: this.nextId++, words })
  }

  private onMessage(m: SpellResponse): void {
    if (m.type === 'checked') {
      const wrong = new Set(m.wrong)
      for (const w of m.words) {
        this.known.set(w, wrong.has(w))
        this.asked.delete(w)
      }
      this.emit()
    } else {
      this.suggestWaits.get(m.id)?.(m.suggestions)
      this.suggestWaits.delete(m.id)
    }
  }

  private post(m: SpellRequest): void {
    this.worker?.postMessage(m)
  }

  private emit(): void {
    if (this.emitTimer) return
    this.emitTimer = window.setTimeout(() => {
      this.emitTimer = 0
      for (const l of this.listeners) l()
    }, 0)
  }
}

export const speller = new Speller()
