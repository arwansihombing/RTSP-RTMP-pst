import { useEffect, useState } from 'react';
import { Copy, Check, FileCode2 } from 'lucide-react';
import type { RustFileItem } from '../types';
import { apiFetch } from '../utils/authFetch';

export function RustProjectView() {
  const [files, setFiles] = useState<RustFileItem[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>('Cargo.toml');
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let mounted = true;
    apiFetch('/api/rust-files')
      .then((res) => (res.ok ? res.json() : { files: [] }))
      .then((data) => {
        if (!mounted) return;
        const list = Array.isArray(data.files) ? (data.files as RustFileItem[]) : [];
        setFiles(list);
        if (list.length > 0 && !list.some((f) => f.path === selectedPath)) {
          setSelectedPath(list[0].path);
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const activeFile = files.find((f) => f.path === selectedPath) ?? files[0] ?? null;

  async function handleCopy() {
    if (!activeFile) return;
    try {
      await navigator.clipboard.writeText(activeFile.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore clipboard permissions error
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-4 border-b border-slate-200">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Rust Source Package (rtsp-rtmp-bridge/)
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Complete Axum 0.7 + Tokio + SQLx SQLite + Vanilla HTML/JS implementation ready for cargo build --release.
          </p>
        </div>

        {activeFile && (
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : `Copy ${activeFile.path}`}
          </button>
        )}
      </div>

      {loading ? (
        <div className="p-8 text-sm text-slate-500">Loading Rust source files...</div>
      ) : files.length === 0 ? (
        <div className="p-8 text-sm text-slate-500">No Rust source files found in rtsp-rtmp-bridge/.</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 min-h-[540px]">
          <aside className="lg:col-span-3 border-b lg:border-b-0 lg:border-r border-slate-200 bg-slate-50 p-3 space-y-1 overflow-y-auto max-h-[700px]">
            {files.map((file) => {
              const active = file.path === activeFile?.path;
              return (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => setSelectedPath(file.path)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs font-mono rounded-md transition-colors ${
                    active
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-700 hover:bg-slate-200/70'
                  }`}
                >
                  <FileCode2 className="h-3.5 w-3.5 shrink-0 opacity-80" />
                  <span className="truncate">{file.path}</span>
                </button>
              );
            })}
          </aside>

          <div className="lg:col-span-9 bg-slate-950 text-slate-100 overflow-auto max-h-[700px]">
            <pre className="p-5 text-xs font-mono leading-relaxed whitespace-pre">
              {activeFile?.content}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
