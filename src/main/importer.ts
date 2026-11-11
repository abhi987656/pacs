import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { ImportProgress, ImportResult } from '@shared/types'
import type { Db, SeriesInsert, StudyInsert } from './db'
import { DICOMDIR_SOP_CLASS, isLikelyNonDicom, readDicomHeader } from './dicom'
import { unzipTo } from './unzip'

const short = (s: string, n: number): string => createHash('sha1').update(s).digest('hex').slice(0, n)

function safeName(s: string, max = 24): string {
  return s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max)
}

/**
 * Imports DICOM files from folders/files into the archive (copying them, so CDs/USBs can be removed).
 * Files are deduplicated by SOP Instance UID.
 */
export class Importer {
  private cancelled = false
  private running = false

  constructor(
    private readonly db: Db,
    private readonly archiveDir: string,
    private readonly onProgress: (p: ImportProgress) => void,
    /** Where ZIP archives are unpacked during an import (emptied afterwards). */
    private readonly tmpDir: string = join(dirname(archiveDir), 'tmp')
  ) {}

  get isRunning(): boolean {
    return this.running
  }

  cancel(): void {
    this.cancelled = true
  }

  async run(inputPaths: string[]): Promise<ImportResult> {
    if (this.running) throw new Error('An import is already running')
    this.running = true
    this.cancelled = false
    const progress: ImportProgress = {
      running: true,
      phase: 'scanning',
      filesFound: 0,
      processed: 0,
      imported: 0,
      duplicates: 0,
      skipped: 0,
      errors: 0,
      studiesTouched: 0,
      currentFile: '',
      message: 'Looking for files…'
    }
    let lastEmit = 0
    const emit = (force = false) => {
      const t = Date.now()
      if (force || t - lastEmit > 120) {
        lastEmit = t
        this.onProgress({ ...progress })
      }
    }
    emit(true)

    const touchedStudies = new Set<number>()
    const unzipDirs: string[] = []
    const zipProblems: string[] = []
    let otherArchives = 0
    try {
      // 1. Collect candidate files (ZIP archives are unpacked to a temporary folder first).
      const files: string[] = []
      const archiveRoot = resolve(this.archiveDir)
      const unpack = async (zipPath: string, depth: number): Promise<void> => {
        if (depth >= 3) return // a ZIP inside a ZIP inside a ZIP: stop there
        const name = basename(zipPath)
        const dir = join(this.tmpDir, `unzip-${randomUUID()}`)
        unzipDirs.push(dir)
        progress.phase = 'unpacking'
        progress.zip = { name, done: 0, total: 0 }
        progress.message = `Unpacking ${name}…`
        emit(true)
        try {
          await unzipTo(zipPath, dir, (u) => {
            progress.zip = { name, done: u.done, total: u.total }
            emit()
          }, () => this.cancelled)
        } catch (e) {
          zipProblems.push((e as Error).message)
          return
        } finally {
          progress.zip = null
          progress.phase = 'scanning'
          emit(true)
        }
        await walk(dir, depth + 1)
      }
      const walk = async (p: string, depth = 0): Promise<void> => {
        if (this.cancelled) return
        let st
        try {
          st = await stat(p)
        } catch {
          return
        }
        if (st.isDirectory()) {
          const abs = resolve(p)
          if (abs === archiveRoot || abs.startsWith(archiveRoot + sep)) return // never re-import our own archive
          let entries
          try {
            entries = await readdir(p, { withFileTypes: true })
          } catch {
            return
          }
          for (const e of entries) {
            if (e.name.startsWith('.') || e.name === '$RECYCLE.BIN' || e.name === 'System Volume Information') continue
            await walk(join(p, e.name), depth)
          }
        } else if (st.isFile()) {
          const lower = p.toLowerCase()
          if (lower.endsWith('.zip')) await unpack(p, depth)
          else if (lower.endsWith('.rar') || lower.endsWith('.7z')) otherArchives++
          else if (!isLikelyNonDicom(p)) {
            files.push(p)
            progress.filesFound = files.length
            emit()
          }
        }
      }
      for (const p of inputPaths) await walk(p)
      progress.phase = 'importing'
      progress.message = `Importing ${files.length} file(s)…`
      emit(true)

      // 2. Parse + copy + index, a few files at a time.
      // No long-running transaction here: the DB is in WAL mode with synchronous=NORMAL, so
      // single-row commits are cheap, and the user can keep saving reports during an import.
      const studyCache = new Map<string, { id: number; folder: string }>()
      const seriesCache = new Map<string, { id: number; folder: string }>()
      const inFlight = new Set<string>()

      const processFile = async (file: string): Promise<void> => {
        progress.currentFile = file
        let h
        try {
          h = await readDicomHeader(file)
        } catch {
          progress.errors++
          return
        }
        if (!h || h.sopClass === DICOMDIR_SOP_CLASS || !h.studyUid || !h.seriesUid || !h.sopUid) {
          progress.skipped++
          return
        }
        if (inFlight.has(h.sopUid) || this.db.hasInstance(h.sopUid)) {
          progress.duplicates++
          return
        }
        inFlight.add(h.sopUid)

        // Study
        let study = studyCache.get(h.studyUid)
        const studyFields: StudyInsert = {
          studyUid: h.studyUid,
          patientId: h.patientId,
          patientName: h.patientName,
          patientNameRaw: h.patientNameRaw,
          birthDate: h.birthDate,
          sex: h.sex,
          age: h.age,
          studyDate: h.studyDate,
          studyTime: h.studyTime,
          description: h.studyDescription,
          accession: h.accession,
          referring: h.referring,
          institution: h.institution,
          bodyPart: h.bodyPart,
          folder: ''
        }
        if (!study) {
          const existingId = this.db.findStudyIdByUid(h.studyUid)
          if (existingId != null) {
            study = { id: existingId, folder: this.db.getStudyFolder(existingId) ?? '' }
          } else {
            const year = (h.studyDate || '0000').slice(0, 4)
            const folder = `${year}/${h.studyDate || 'nodate'}_${safeName(h.patientId || 'noid', 16)}_${short(h.studyUid, 10)}`
            studyFields.folder = folder
            // A case typed in by hand (reported before the CD arrived) with the same accession/PG No
            // gets these images, so the report and the images end up together.
            const manualId = this.db.findManualStudyFor(h.accession, h.patientId)
            if (manualId != null) {
              this.db.adoptManualStudy(manualId, studyFields)
              study = { id: manualId, folder }
            } else {
              study = { id: this.db.insertStudy(studyFields), folder }
            }
          }
          studyCache.set(h.studyUid, study)
        }
        this.db.fillStudyBlanks(study.id, studyFields)
        touchedStudies.add(study.id)

        // Series
        let series = seriesCache.get(h.seriesUid)
        if (!series) {
          const existingId = this.db.findSeriesIdByUid(h.seriesUid)
          if (existingId != null) {
            series = { id: existingId, folder: this.db.getSeriesFolder(existingId) }
          } else {
            const folder = `${study.folder}/s${h.seriesNumber ?? 0}_${short(h.seriesUid, 10)}`
            const s: SeriesInsert = {
              seriesUid: h.seriesUid,
              number: h.seriesNumber,
              description: h.seriesDescription,
              modality: h.modality,
              bodyPart: h.bodyPart,
              isImage: h.rows > 0 && h.cols > 0,
              folder
            }
            series = { id: this.db.insertSeries(study.id, s), folder }
          }
          seriesCache.set(h.seriesUid, series)
        }
        if (h.rows > 0 && h.cols > 0) this.db.markSeriesImage(series.id, true)

        // Copy file into the archive.
        const relPath = `${series.folder}/${short(h.sopUid, 20)}.dcm`
        const dest = join(this.archiveDir, ...relPath.split('/'))
        await mkdir(join(this.archiveDir, ...series.folder.split('/')), { recursive: true })
        await copyFile(file, dest)

        this.db.insertInstance(series.id, {
          sopUid: h.sopUid,
          sopClass: h.sopClass,
          instanceNumber: h.instanceNumber,
          frames: h.frames,
          ipp: h.ipp,
          iop: h.iop,
          sliceLocation: h.sliceLocation,
          forUid: h.forUid,
          rows: h.rows,
          cols: h.cols,
          relPath
        })
        progress.imported++
      }

      // Process sequentially-in-order but with small parallelism for I/O.
      const CONCURRENCY = 4
      let index = 0
      const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (!this.cancelled) {
          const i = index++
          if (i >= files.length) break
          try {
            await processFile(files[i])
          } catch (e) {
            progress.errors++
            console.error('[import] failed', files[i], e)
          }
          progress.processed++
          progress.studiesTouched = touchedStudies.size
          emit()
        }
      })
      await Promise.all(workers)

      // 3. Update counts.
      this.db.transaction(() => {
        for (const id of touchedStudies) this.db.refreshStudyCounts(id)
      })

      progress.phase = this.cancelled ? 'cancelled' : 'done'
      progress.running = false
      progress.studiesTouched = touchedStudies.size
      progress.currentFile = ''
      const archiveNote =
        (zipProblems.length ? ` ${zipProblems.join(' ')}` : '') +
        (otherArchives ? ` ${otherArchives} RAR/7-Zip archive(s) skipped – extract them first, then import the folder.` : '')
      if (zipProblems.length && !progress.imported) progress.errors++
      progress.message = this.cancelled
        ? `Import cancelled. ${progress.imported} image(s) imported.`
        : `Imported ${progress.imported} image(s) in ${touchedStudies.size} study(ies).` +
          (progress.duplicates ? ` ${progress.duplicates} already in archive.` : '') +
          (progress.skipped ? ` ${progress.skipped} non-DICOM file(s) skipped.` : '') +
          (progress.errors ? ` ${progress.errors} error(s).` : '') +
          archiveNote
      emit(true)
      return { ...progress, studyIds: [...touchedStudies] }
    } catch (e) {
      progress.running = false
      progress.phase = 'done'
      progress.message = `Import failed: ${(e as Error).message}`
      emit(true)
      return { ...progress, studyIds: [...touchedStudies] }
    } finally {
      for (const d of unzipDirs) await rm(d, { recursive: true, force: true }).catch(() => {})
      this.running = false
    }
  }
}
