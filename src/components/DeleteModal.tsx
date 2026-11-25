import { X, AlertTriangle } from 'lucide-react';
import type { StreamItem } from '../types';

interface DeleteModalProps {
  stream: StreamItem | null;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteModal({ stream, deleting, onCancel, onConfirm }: DeleteModalProps) {
  if (!stream) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-modal-title"
    >
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 id="delete-modal-title" className="text-base font-semibold text-slate-900">
            Delete Stream
          </h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close delete confirmation"
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-md hover:bg-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-6 space-y-3">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-md bg-red-50 text-red-600 shrink-0">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="text-sm text-slate-700 space-y-1">
              <p>
                Stop and permanently delete <strong className="text-slate-900">{stream.name}</strong>?
              </p>
              <p className="text-xs text-slate-500">
                Any active FFmpeg child process for this stream will receive SIGTERM and be removed from SQLite.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 bg-slate-50 border-t border-slate-200">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 disabled:opacity-50"
          >
            {deleting ? 'Deleting...' : 'Delete Stream'}
          </button>
        </div>
      </div>
    </div>
  );
}
