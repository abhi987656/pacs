import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  FileDown,
  History,
  Lock,
  Mic,
  MoreVertical,
  Pencil,
  Save,
  Square,
} from "lucide-react";
import {
  formatAge,
  formatDicomDate,
  formatDicomDateTime,
  formatSex,
  STATUS_LABEL,
} from "@shared/format";
import { fillPlaceholders } from "../../renderer/src/ris/editor";
import type { Nav } from "../App";
import { leaveGuards } from "../App";
import { store, useStore } from "../db";
import type { LocalStudy, LocalTemplate } from "../db";
import { blankReport, editCaseDetails, saveReportLocal } from "../repo";
import { sync } from "../sync";
import {
  EditorToolbar,
  MobileEditor,
  safeHtml,
  useMobileEditor,
} from "../editor";
import { useDictation } from "../useDictation";
import { exportAndSave, exportAndShare } from "../exportReport";
import type { ExportKind } from "../exportReport";
import { Picker } from "../Picker";
import { Page, useUi } from "../ui";

const KIND_LABEL: Record<ExportKind, string> = {
  docx: "Word document",
  pdf: "PDF",
  txt: "Text file",
};

export function ReportScreen({
  nav,
  studySyncId,
}: {
  nav: Nav;
  studySyncId: string;
}) {
  useStore();
  const ui = useUi();
  const study = store.studies.get(studySyncId);
  const initial = useMemo(
    () => store.reports.get(studySyncId) ?? (study ? blankReport(study) : null),
    [],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const [status, setStatus] = useState(initial?.status ?? "NEW");
  const readOnly = status === "FINAL";
  const [showInfo, setShowInfo] = useState(false);
  const [clinical, setClinical] = useState(study?.clinicalHistory ?? "");
  const [picker, setPicker] = useState<"template" | "macro" | "prior" | null>(
    null,
  );
  const [priorView, setPriorView] = useState<LocalStudy | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const templateNameRef = useRef(initial?.templateName ?? "");
  const loadedHtmlRef = useRef(initial?.html ?? "");
  const unsavedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const macrosRef = useRef(store.liveMacros());
  macrosRef.current = store.liveMacros();
  const flushRef = useRef<(s?: "DRAFT" | "PRELIMINARY") => Promise<void>>(
    async () => {},
  );

  const editor = useMobileEditor({
    content: initial?.html ?? "",
    editable: initial?.status !== "FINAL",
    placeholder:
      "Type the report, choose a template, type a macro like .nad – or tap the mic and speak.",
    getMacros: () => macrosRef.current,
    onChange: () => {
      unsavedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void flushRef.current(), 800);
    },
  });

  /** Saves the editor text on the phone (and marks it for the next sync). */
  const flush = useCallback(
    async (newStatus?: "DRAFT" | "PRELIMINARY") => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (!editor || readOnly) return;
      if (!unsavedRef.current && !newStatus) return;
      if (!newStatus && editor.isEmpty && !store.reports.get(studySyncId)) {
        unsavedRef.current = false;
        return;
      }
      const html = editor.getHTML();
      const rep = await saveReportLocal(studySyncId, {
        html,
        text: editor.getText(),
        status: newStatus,
        templateName: templateNameRef.current,
      });
      unsavedRef.current = false;
      loadedHtmlRef.current = html;
      if (rep) setStatus(rep.status);
    },
    [editor, readOnly, studySyncId],
  );
  flushRef.current = flush;

  useEffect(() => {
    const guard = () => flushRef.current();
    leaveGuards.add(guard);
    return () => {
      leaveGuards.delete(guard);
      void flushRef.current();
    };
  }, []);

  // The PC changed this report (sync): show its version unless the user is in the middle of typing.
  const rep = store.reports.get(studySyncId);
  useEffect(() => {
    if (!rep || !editor) return;
    if (rep.status !== status && !unsavedRef.current) setStatus(rep.status);
    if (
      unsavedRef.current ||
      timerRef.current ||
      rep.html === loadedHtmlRef.current
    )
      return;
    loadedHtmlRef.current = rep.html;
    editor.commands.setContent(rep.html, { emitUpdate: false });
    editor.setEditable(rep.status !== "FINAL", false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rep?.html, rep?.status, editor]);

  useEffect(() => {
    editor?.setEditable(!readOnly, false);
  }, [editor, readOnly]);

  const priors = useMemo(() => {
    if (!study?.patientId.trim()) return [];
    return [...store.studies.values()]
      .filter(
        (s) =>
          s.syncId !== study.syncId &&
          s.patientId.trim().toUpperCase() ===
            study.patientId.trim().toUpperCase(),
      )
      .sort((a, b) =>
        (b.studyDate + b.studyTime).localeCompare(a.studyDate + a.studyTime),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [study?.patientId, store.version]);

  const templates = useMemo(() => {
    const mod = study?.modalities.split("\\")[0] ?? "";
    return store
      .liveTemplates()
      .sort(
        (a, b) =>
          Number(b.modality === mod) - Number(a.modality === mod) ||
          a.name.localeCompare(b.name),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.version, study?.modalities]);

  const dict = useDictation(editor, {
    onTemplate: (name) => {
      const words = name.toLowerCase().split(/\s+/).filter(Boolean);
      const t = templates.find((x) =>
        words.every((w) => x.name.toLowerCase().includes(w)),
      );
      if (t) void applyTemplate(t);
      return !!t;
    },
    onError: (m) => ui.toast(m, "error"),
  });

  if (!study || !editor) {
    return (
      <Page title="Case not found" onBack={() => nav.back()}>
        <div className="m-empty">This case is no longer on the phone.</div>
      </Page>
    );
  }

  const placeholderCtx = () => ({
    patient_name: study.patientName,
    patient_id: study.patientId,
    age: formatAge(study.age, study.birthDate, study.studyDate),
    sex: formatSex(study.sex),
    study: study.description,
    study_date: formatDicomDate(study.studyDate),
    accession: study.accession,
    referring: study.referring,
    radiologist: store.meta.settings.radiologistName,
    prior_date: priors[0] ? formatDicomDate(priors[0].studyDate) : "",
    today: new Date().toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }),
  });

  async function applyTemplate(t: LocalTemplate) {
    if (!editor || readOnly) return;
    const html = fillPlaceholders(t.html, placeholderCtx());
    let mode: string | null = "replace";
    if (!editor.isEmpty) {
      mode = await ui.choose(
        "Use template",
        `“${t.name}” – replace the current text, or insert it where the cursor is?`,
        [
          { label: "Cancel", value: "cancel" },
          { label: "Insert", value: "insert" },
          { label: "Replace all", value: "replace", kind: "primary" },
        ],
      );
    }
    if (mode === "replace") editor.chain().setContent(html).run();
    else if (mode === "insert")
      editor.chain().focus().insertContent(html).run();
    else return;
    templateNameRef.current = t.name;
    unsavedRef.current = true;
    void flush();
  }

  const save = async (newStatus: "DRAFT" | "PRELIMINARY") => {
    await flush(newStatus);
    await sync.sync();
    const st = sync.getStatus();
    ui.toast(
      st.phase === "idle"
        ? newStatus === "PRELIMINARY"
          ? "Saved as preliminary and sent to the PC"
          : "Saved and sent to the PC"
        : "Saved on the phone – it will be sent when the PC is found",
      st.phase === "idle" ? "success" : "info",
    );
  };

  const doExport = (kind: ExportKind) => {
    ui.sheet(KIND_LABEL[kind], [
      {
        label: "Send / open…",
        hint: "WhatsApp, Gmail, Drive, Word, PDF viewer…",
        onSelect: () => void runExport(kind, "share"),
      },
      {
        label: "Save to phone",
        hint: "Documents › PersonalPACS",
        onSelect: () => void runExport(kind, "save"),
      },
    ]);
  };

  const runExport = async (kind: ExportKind, how: "share" | "save") => {
    await flush();
    setBusy(`Making ${KIND_LABEL[kind]}…`);
    try {
      const s = store.studies.get(studySyncId)!;
      const r = store.reports.get(studySyncId) ?? null;
      if (how === "share") await exportAndShare(kind, s, r);
      else ui.toast(`Saved: ${await exportAndSave(kind, s, r)}`, "success");
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (!/cancel/i.test(msg)) ui.toast(`Export failed: ${msg}`, "error");
    } finally {
      setBusy(null);
    }
  };

  const menu = () =>
    ui.sheet(study.patientName || "Case", [
      {
        label: "Edit patient / study details",
        onSelect: () => nav.push({ name: "case-form", id: studySyncId }),
      },
      {
        label: `Previous reports (${priors.length})`,
        onSelect: () => setPicker("prior"),
      },
      { label: "Export as Word (.docx)", onSelect: () => doExport("docx") },
      { label: "Export as PDF", onSelect: () => doExport("pdf") },
      { label: "Export as text (.txt)", onSelect: () => doExport("txt") },
    ]);

  const listening = dict.phase !== "off";

  return (
    <Page
      className="m-report"
      title={study.patientName || "(no name)"}
      subtitle={
        <>
          <span className={`m-badge st-${status}`}>
            {STATUS_LABEL[status] ?? status}
          </span>{" "}
          {study.description || study.modalities}
        </>
      }
      onBack={() => nav.back()}
      actions={
        <button className="m-icon-btn" onClick={menu} aria-label="More">
          <MoreVertical size={22} />
        </button>
      }
      footer={
        readOnly ? undefined : (
          <div className="m-actions">
            <button
              className={`m-mic ${listening ? "on" : ""}`}
              onClick={() => void dict.toggle()}
              aria-label={listening ? "Stop dictation" : "Dictate"}
            >
              {listening ? <Square size={20} /> : <Mic size={22} />}
            </button>
            <button
              className="m-btn primary"
              onClick={() =>
                void save(status === "PRELIMINARY" ? "PRELIMINARY" : "DRAFT")
              }
            >
              <Save size={17} /> Save
            </button>
            <button
              className="m-btn plain"
              onClick={() => void save("PRELIMINARY")}
            >
              Preliminary
            </button>
            <button
              className="m-icon-btn"
              onClick={() =>
                ui.sheet(
                  "Export report",
                  (["docx", "pdf", "txt"] as ExportKind[]).map((k) => ({
                    label: KIND_LABEL[k],
                    onSelect: () => doExport(k),
                  })),
                )
              }
              aria-label="Export"
            >
              <FileDown size={22} />
            </button>
          </div>
        )
      }
    >
      <section className="m-info">
        <button className="m-info-head" onClick={() => setShowInfo((x) => !x)}>
          <span>
            {[
              formatAge(study.age, study.birthDate, study.studyDate),
              formatSex(study.sex),
            ]
              .filter(Boolean)
              .join(" / ") || "—"}
            {study.patientId && <> · CR {study.patientId}</>}
            {study.accession && <> · PG {study.accession}</>}
          </span>
          {showInfo ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>
        {showInfo && (
          <div className="m-info-body">
            <div className="m-kv">
              <span>Exam date</span>
              <b>
                {formatDicomDateTime(study.studyDate, study.studyTime) || "—"}
              </b>
            </div>
            <div className="m-kv">
              <span>Referring</span>
              <b>{study.referring || "—"}</b>
            </div>
            <div className="m-kv">
              <span>Visit</span>
              <b>{study.visitType || "—"}</b>
            </div>
            <div className="m-kv">
              <span>Images</span>
              <b>
                {study.numImages
                  ? `${study.numImages} (view on the PC)`
                  : "none yet"}
              </b>
            </div>
            <button
              className="m-link"
              onClick={() => nav.push({ name: "case-form", id: studySyncId })}
            >
              <Pencil size={14} /> Edit details
            </button>
          </div>
        )}
        {(!readOnly || clinical.trim()) && (
          <label className="m-clinical">
            <span>Clinical details</span>
            <textarea
              rows={2}
              value={clinical}
              placeholder="Clinical history / indication"
              disabled={readOnly}
              onChange={(e) => setClinical(e.target.value)}
              onBlur={() => {
                if (clinical !== study.clinicalHistory)
                  void editCaseDetails(studySyncId, {
                    clinicalHistory: clinical,
                  });
              }}
            />
          </label>
        )}
        {priors.length > 0 && (
          <button className="m-link" onClick={() => setPicker("prior")}>
            <History size={14} /> Previous reports ({priors.length})
          </button>
        )}
      </section>

      {readOnly && (
        <div className="m-banner">
          <Lock size={14} /> Signed off on the PC – read only. To change it,
          reopen the report on the PC.
        </div>
      )}

      <EditorToolbar
        editor={editor}
        extra={
          <>
            <button
              className="m-tool text"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setPicker("template")}
            >
              Template
            </button>
            <button
              className="m-tool text"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setPicker("macro")}
            >
              Macro
            </button>
          </>
        }
      />
      <div
        className="m-paper"
        style={{
          fontFamily: `'${store.meta.settings.editorFontFamily}', 'Noto Serif', serif`,
        }}
      >
        <MobileEditor editor={editor} />
      </div>

      {listening && (
        <div className="m-dict-bubble">
          <span className="m-dict-dot" />
          {dict.partial ||
            (dict.phase === "starting"
              ? "Starting the microphone…"
              : "Listening – speak now")}
        </div>
      )}
      {busy && (
        <div className="m-backdrop center">
          <div className="m-dialog m-busy">
            <div className="m-spinner" /> {busy}
          </div>
        </div>
      )}

      {picker === "template" && (
        <Picker
          title="Templates"
          items={templates}
          keyOf={(t) => t.syncId}
          textOf={(t) => `${t.name} ${t.modality}`}
          empty="No templates yet. They come from the PC, or add them under Templates."
          render={(t) => (
            <>
              <span className="m-row-main">{t.name}</span>
              <span className="m-row-side">{t.modality}</span>
            </>
          )}
          onClose={() => setPicker(null)}
          onPick={(t) => {
            setPicker(null);
            void applyTemplate(t);
          }}
        />
      )}
      {picker === "macro" && (
        <Picker
          title="Macros"
          items={store
            .liveMacros()
            .sort((a, b) => a.code.localeCompare(b.code))}
          keyOf={(m) => m.syncId}
          textOf={(m) => `${m.code} ${m.text}`}
          empty="No macros yet."
          render={(m) => (
            <>
              <span className="m-row-main">.{m.code}</span>
              <span className="m-row-sub">{m.text}</span>
            </>
          )}
          onClose={() => setPicker(null)}
          onPick={(m) => {
            setPicker(null);
            editor
              .chain()
              .focus()
              .insertContent(
                m.text.includes("\n")
                  ? m.text
                      .split("\n")
                      .map(
                        (l) =>
                          `<p>${l.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)}</p>`,
                      )
                      .join("")
                  : m.text + " ",
              )
              .run();
          }}
        />
      )}
      {picker === "prior" && (
        <Picker
          title="Previous reports"
          items={priors}
          keyOf={(s) => s.syncId}
          textOf={(s) =>
            `${s.description} ${s.modalities} ${formatDicomDate(s.studyDate)}`
          }
          empty="No previous studies of this patient on the phone."
          render={(s) => (
            <>
              <span className="m-row-main">
                {formatDicomDate(s.studyDate)} · {s.description || s.modalities}
              </span>
              <span className={`m-badge st-${s.reportStatus}`}>
                {STATUS_LABEL[s.reportStatus]}
              </span>
            </>
          )}
          onClose={() => setPicker(null)}
          onPick={(s) => {
            setPicker(null);
            setPriorView(s);
          }}
        />
      )}
      {priorView && (
        <div className="m-overlay">
          <header className="m-topbar">
            <div className="m-topbar-title">
              <div className="m-title">
                {formatDicomDate(priorView.studyDate)}
              </div>
              <div className="m-subtitle">
                {priorView.description || priorView.modalities}
              </div>
            </div>
            <button className="m-btn plain" onClick={() => setPriorView(null)}>
              Close
            </button>
          </header>
          <div className="m-body">
            <div className="m-paper">
              {store.reports.get(priorView.syncId)?.html ? (
                <div
                  className="report-doc m-doc"
                  dangerouslySetInnerHTML={{
                    __html: safeHtml(store.reports.get(priorView.syncId)!.html),
                  }}
                />
              ) : (
                <p className="m-muted">No report for this study.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}
