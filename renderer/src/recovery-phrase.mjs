export function emptyRecoveryPhraseState() {
  return { open: false, busy: false, error: null, backup: null, revealed: false };
}

// Invalidate outstanding requests on hide/close so late decryption results cannot
// put the phrase back into a closed dialog or a newly opened one.
export function createRecoveryPhraseController({ fetchBackup, onChange }) {
  let state = emptyRecoveryPhraseState();
  let generation = 0;
  const publish = (next) => { state = next; onChange(next); };
  const clear = (open) => {
    generation++;
    publish({ ...emptyRecoveryPhraseState(), open });
  };
  return {
    open: () => clear(true),
    close: () => clear(false),
    dispose: () => { generation++; state = emptyRecoveryPhraseState(); },
    async toggleReveal() {
      if (!state.open || state.busy) return;
      if (state.revealed) { clear(true); return; }
      const requestGeneration = ++generation;
      publish({ ...state, busy: true, error: null });
      try {
        const result = await fetchBackup();
        if (generation !== requestGeneration || !state.open) return;
        if (!result?.ok) throw new Error(result?.error || "Failed to load recovery phrase.");
        publish({ ...state, busy: false, revealed: true, backup: result.backup || null });
      } catch (error) {
        if (generation !== requestGeneration || !state.open) return;
        publish({ ...state, busy: false, backup: null, error: String(error?.message || error) });
      }
    },
  };
}
