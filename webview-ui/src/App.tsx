import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { toMajorMinor } from './changelogData.js';
import { BottomToolbar } from './components/BottomToolbar.js';
import { ChangelogModal } from './components/ChangelogModal.js';
import { ConnectionIndicator } from './components/ConnectionIndicator.js';
import { DebugView } from './components/DebugView.js';
import { EditActionBar } from './components/EditActionBar.js';
import { IntroBubble } from './components/IntroBubble.js';
import { MigrationNotice } from './components/MigrationNotice.js';
import { NewAgentModal } from './components/NewAgentModal.js';
import { SettingsModal } from './components/SettingsModal.js';
import type { RailAgent } from './components/terminal/AgentRail.js';
import type { PanelPosition } from './components/terminal/panelPosition.js';
import {
  loadPanelOpen,
  loadPanelPosition,
  savePanelOpen,
  savePanelPosition,
} from './components/terminal/panelPosition.js';
import { TerminalBand } from './components/terminal/TerminalBand.js';
import { Tooltip } from './components/Tooltip.js';
import { Modal } from './components/ui/Modal.js';
import { VersionIndicator } from './components/VersionIndicator.js';
import { ZoomControls } from './components/ZoomControls.js';
import { useEditorActions } from './hooks/useEditorActions.js';
import { useEditorKeyboard } from './hooks/useEditorKeyboard.js';
import { useExtensionMessages } from './hooks/useExtensionMessages.js';
import { useIntroTour } from './hooks/useIntroTour.js';
import { OfficeCanvas } from './office/components/OfficeCanvas.js';
import { ToolOverlay } from './office/components/ToolOverlay.js';
import { EditorState } from './office/editor/editorState.js';
import { EditorToolbar } from './office/editor/EditorToolbar.js';
import { characterLabel } from './office/engine/characters.js';
import { OfficeState } from './office/engine/officeState.js';
import { exportLayoutToFile } from './office/layout/exportLayout.js';
import { isRotatable } from './office/layout/furnitureCatalog.js';
import { migrateLayoutColors } from './office/layout/layoutSerializer.js';
import { useCharacterPtyActivity } from './office/panel/useCharacterPtyActivity.js';
import { getPetCount } from './office/sprites/petSpriteData.js';
import { EditTool, type OfficeLayout } from './office/types.js';
import { hasPrivilegedToken, isBrowserRuntime, isE2E } from './runtime.js';
import { installTestHooks } from './testHooks.js';
import { transport } from './transport/index.js';

// Game state lives outside React — updated imperatively by message handlers
const officeStateRef = { current: null as OfficeState | null };
const editorState = new EditorState();

// Test-only observability hooks (message/sound logs, addAgent wrapper, selectAgent).
// Installed only under the e2e harness so they never patch prototypes or grow
// unbounded logs in a real user's session.
if (isE2E) installTestHooks(officeStateRef);

function getOfficeState(): OfficeState {
  if (!officeStateRef.current) {
    officeStateRef.current = new OfficeState();
  }
  return officeStateRef.current;
}

function App() {
  // Browser runtime (dev or static dist): dispatch mock messages after the
  // useExtensionMessages listener has been registered.
  useEffect(() => {
    // browserMock is for Vite dev mode only (UI prototyping without a server).
    // In standalone server mode, the server sends all state over WebSocket.
    // In VS Code mode, the extension sends all state via postMessage.
    if (isBrowserRuntime && import.meta.env.DEV) {
      void import('./browserMock.js').then(({ dispatchMockMessages }) => dispatchMockMessages());
    }
  }, []);

  const editor = useEditorActions(getOfficeState, editorState);

  const isEditDirty = useCallback(
    () => editor.isEditMode && editor.isDirty,
    [editor.isEditMode, editor.isDirty],
  );

  const {
    agents,
    selectedAgent,
    agentTools,
    agentStatuses,
    subagentTools,
    subagentCharacters,
    layoutReady,
    layoutWasReset,
    loadedAssets,
    workspaceFolders,
    agentFolderNames,
    externalAssetDirectories,
    lastSeenVersion,
    extensionVersion,
    watchAllSessions,
    setWatchAllSessions,
    alwaysShowLabels,
    showTerminalNames,
    ghostHeadlessAgents,
    setGhostHeadlessAgents,
    hooksEnabled,
    hooksInstalled,
    hooksStatusSeq,
    hooksInfoShown,
    consentRequest,
    dismissConsentRequest,
    areaMappings,
    setAreaMappings,
    showAreas,
    setShowAreas,
    recentAgentFolders,
    launchAgentFailure,
    ptyBackedByAgent,
    customTitles,
    terminalNames,
    ptyEventBus,
    teammateIds,
    movePending,
    moveErrors,
    markMovePending,
  } = useExtensionMessages(getOfficeState, editor.setLastSavedLayout, isEditDirty);

  // ── Standalone terminal band (browser runtime only) ──
  const [focusedTerminalId, setFocusedTerminalId] = useState<number | null>(null);
  // Terminal band visibility — toggles with character selection (select a
  // pty-backed agent → open on it; deselect → close), persisted per browser.
  const [terminalOpen, setTerminalOpenState] = useState(() => loadPanelOpen());
  const setTerminalOpen = useCallback((open: boolean) => {
    setTerminalOpenState((prev) => {
      // Skip the localStorage write when nothing changed — every empty-floor
      // click routes through here.
      if (prev !== open) savePanelOpen(open);
      return open;
    });
  }, []);
  // Set when the user submits the New-agent form; the next pty agent to
  // appear auto-opens the band focused on itself (v2's openForNewAgent).
  const pendingSpawnOpenRef = useRef(false);
  const prevRailIdsRef = useRef<Set<number>>(new Set());
  const [isNewAgentOpen, setIsNewAgentOpen] = useState(false);
  // A refused launchAgent re-opens the form with the rejected folder and the
  // server's reason — the alternative (silently spawning in the server's own
  // cwd) looks like success. Keyed on seq so a repeated refusal re-opens.
  useEffect(() => {
    if (launchAgentFailure) {
      // Disarm the spawn auto-open: the refused launch produced no agent, and
      // a stale flag would auto-open on the NEXT pty agent from any source
      // (another tab's spawn included).
      pendingSpawnOpenRef.current = false;
      setIsNewAgentOpen(true);
    }
  }, [launchAgentFailure]);
  // Every top-level agent: in-office (pty-backed) ones AND adopted sessions
  // still running outside the office. Teammates stay out (clicking one
  // reaches its lead); sub-agents are never in `agents`.
  const railAgents = useMemo(
    () =>
      agents
        .filter((id) => !teammateIds[id] && !getOfficeState().subagentMeta.has(id))
        .map((id): RailAgent => ({
          id,
          label: characterLabel({
            customTitle: customTitles[id],
            agentName: getOfficeState().characters.get(id)?.agentName,
            terminalName: terminalNames[id],
            id,
          }),
          inOffice: ptyBackedByAgent[id] === true,
          moveState: movePending[id] ? 'pending' : moveErrors[id] ? 'error' : 'idle',
          moveError: moveErrors[id],
        })),
    [agents, teammateIds, ptyBackedByAgent, customTitles, terminalNames, movePending, moveErrors],
  );

  // Prune a dead terminal focus: the band falls back visually on its own,
  // but App state (and OfficeCanvas's focusedAgentId prop) must not keep
  // pointing at a closed agent.
  useEffect(() => {
    if (focusedTerminalId !== null && !railAgents.some((a) => a.id === focusedTerminalId)) {
      setFocusedTerminalId(null);
    }
  }, [focusedTerminalId, railAgents]);

  // A spawn the user just submitted auto-opens the band on the new agent as
  // soon as its rail entry materializes (v2's openForNewAgent).
  useEffect(() => {
    const prev = prevRailIdsRef.current;
    // Only ATTACHED entries count: a scanner adoption landing during a pending
    // spawn must not steal the auto-open onto a placeholder.
    const fresh = railAgents.filter((a) => a.inOffice && !prev.has(a.id));
    prevRailIdsRef.current = new Set(railAgents.map((a) => a.id));
    if (pendingSpawnOpenRef.current && fresh.length > 0) {
      pendingSpawnOpenRef.current = false;
      setFocusedTerminalId(fresh[fresh.length - 1].id);
      setTerminalOpen(true);
    }
  }, [railAgents, setTerminalOpen]);

  // Show migration notice once layout reset is detected
  const [migrationNoticeDismissed, setMigrationNoticeDismissed] = useState(false);
  const showMigrationNotice = layoutWasReset && !migrationNoticeDismissed;

  const [isChangelogOpen, setIsChangelogOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHooksInfoOpen, setIsHooksInfoOpen] = useState(false);
  const [hooksTooltipDismissed, setHooksTooltipDismissed] = useState(false);
  const [isDebugMode, setIsDebugMode] = useState(false);
  const [alwaysShowOverlay, setAlwaysShowOverlay] = useState(false);

  const currentMajorMinor = toMajorMinor(extensionVersion);

  const handleWhatsNewDismiss = useCallback(() => {
    transport.send({ type: 'setLastSeenVersion', version: currentMajorMinor });
  }, [currentMajorMinor]);

  const handleOpenChangelog = useCallback(() => {
    setIsChangelogOpen(true);
    transport.send({ type: 'setLastSeenVersion', version: currentMajorMinor });
  }, [currentMajorMinor]);

  // Sync alwaysShowOverlay from persisted settings
  useEffect(() => {
    setAlwaysShowOverlay(alwaysShowLabels);
  }, [alwaysShowLabels]);

  // Nameplates under characters (Show Agent Names) — default ON, synced from
  // persisted settings like alwaysShowOverlay above.
  const [showNameplates, setShowNameplates] = useState(true);
  useEffect(() => {
    setShowNameplates(showTerminalNames);
  }, [showTerminalNames]);
  const handleToggleShowNameplates = useCallback(() => {
    setShowNameplates((prev) => {
      const newVal = !prev;
      transport.send({ type: 'setShowTerminalNames', enabled: newVal });
      return newVal;
    });
  }, []);

  // Terminal band dock side — webview-local (see panelPosition.ts).
  const [panelPosition, setPanelPosition] = useState<PanelPosition>(() => loadPanelPosition());
  const handleChangePanelPosition = useCallback((p: PanelPosition) => {
    setPanelPosition(p);
    savePanelPosition(p);
  }, []);

  const handleToggleDebugMode = useCallback(() => setIsDebugMode((prev) => !prev), []);
  const handleToggleAlwaysShowOverlay = useCallback(() => {
    setAlwaysShowOverlay((prev) => {
      const newVal = !prev;
      transport.send({ type: 'setAlwaysShowLabels', enabled: newVal });
      return newVal;
    });
  }, []);

  // Toggle "Display headless as ghosts". setGhostHeadlessAgents also updates the
  // renderer's module copy, so the office redraws on the next frame.
  const handleToggleGhostHeadlessAgents = useCallback(() => {
    const next = !ghostHeadlessAgents;
    setGhostHeadlessAgents(next);
    transport.send({ type: 'setGhostHeadlessAgents', enabled: next });
  }, [ghostHeadlessAgents, setGhostHeadlessAgents]);

  const handleSelectAgent = useCallback((id: number) => {
    transport.send({ type: 'focusAgent', id });
  }, []);

  // The Intro's wire-facing state machine — which asks survive being mooted,
  // when a hooksStatus is this tour's install verdict — lives in useIntroTour
  // (pure reducer in introTourState.ts); the App only wires it to the bubble.
  const {
    intro,
    installFailed,
    installPending,
    onChoice: handleConsentChoice,
    onClose: handleIntroClose,
  } = useIntroTour({ consentRequest, hooksInstalled, hooksStatusSeq, dismissConsentRequest });

  // The Settings surface renders one provider today; its checkbox binds to
  // the Claude row of the per-provider install-state map.
  const claudeHooksInstalled = hooksInstalled['claude'] === true;

  // Mutate folder→Area mappings locally + send to server. Updates OfficeState in
  // the same tick so a follow-up agentCreated picks up the new mapping.
  const handleAreaMappingChange = useCallback(
    (folderName: string, areaLabel: string, action: 'add' | 'remove') => {
      const current = areaMappings[folderName] ?? [];
      let nextLabels: string[];
      if (action === 'add') {
        if (current.includes(areaLabel)) return;
        nextLabels = [...current, areaLabel];
      } else {
        nextLabels = current.filter((l) => l !== areaLabel);
      }
      const next = { ...areaMappings };
      if (nextLabels.length === 0) {
        delete next[folderName];
      } else {
        next[folderName] = nextLabels;
      }
      setAreaMappings(next);
      getOfficeState().setAreaMappings(next);
      transport.send({ type: 'saveAreaMappings', mappings: next });
    },
    [areaMappings, setAreaMappings],
  );

  // Toggle global Show Areas — persisted via setShowAreas message; runs server-
  // side through configPersistence.
  const onToggleShowAreas = useCallback(() => {
    const next = !showAreas;
    setShowAreas(next);
    transport.send({ type: 'setShowAreas', enabled: next });
  }, [showAreas, setShowAreas]);

  // When AREA_PAINT is active in the editor, force the overlay on even if the
  // user has toggled Show Areas off globally — they need to see what they're
  // editing. The selected area's overlay is alpha-bumped via activeAreaLabel.
  const isEditingAreas = editor.isEditMode && editorState.activeTool === EditTool.AREA_PAINT;
  const effectiveShowAreas = isEditingAreas || showAreas;
  const activeAreaLabel = isEditingAreas ? editor.selectedAreaLabel : null;

  // e2e: register the component-scoped editor-action drivers + the effective
  // show-areas gate on the test-hooks namespace (module-load installTestHooks
  // can't reach these React callbacks). Bypasses only canvas pixel→tile
  // geometry — the handlers still own undo/dirty/rebuild. Guarded on isE2E.
  useEffect(() => {
    if (!isE2E || typeof window === 'undefined') return;
    const hooks = (window.__pixelAgentsTestHooks ??= {});
    hooks.editorTileAction = (col, row) => editor.handleEditorTileAction(col, row);
    hooks.editorEraseAction = (col, row) => editor.handleEditorEraseAction(col, row);
    hooks.getShowAreas = () => effectiveShowAreas;
  }, [editor.handleEditorTileAction, editor.handleEditorEraseAction, effectiveShowAreas]);

  const containerRef = useRef<HTMLDivElement>(null);

  const [editorTickForKeyboard, setEditorTickForKeyboard] = useState(0);
  useEditorKeyboard(
    editor.isEditMode,
    editorState,
    editor.handleDeleteSelected,
    editor.handleRotateSelected,
    editor.handleToggleState,
    editor.handleUndo,
    editor.handleRedo,
    useCallback(() => setEditorTickForKeyboard((n) => n + 1), []),
    editor.handleToggleEditMode,
  );

  const handleCloseAgent = useCallback((id: number) => {
    transport.send({ type: 'closeAgent', id });
  }, []);

  // An adopted session still running outside the office can be moved in by
  // clicking its character or rail entry. The server enforces the same rule
  // (moveRefusalReason); this is the UX gate.
  const isMovable = useCallback(
    (id: number) =>
      isBrowserRuntime && hasPrivilegedToken && !ptyBackedByAgent[id] && !teammateIds[id],
    [ptyBackedByAgent, teammateIds],
  );

  const requestMove = useCallback(
    (id: number) => {
      if (!isMovable(id) || movePending[id]) return;
      markMovePending(id);
      transport.send({ type: 'moveSessionHere', id });
    },
    [isMovable, movePending, markMovePending],
  );

  const handleRailFocus = useCallback(
    (id: number) => {
      setFocusedTerminalId(id);
      requestMove(id); // no-op for inOffice agents
    },
    [requestMove],
  );

  const handleRenameAgent = useCallback((id: number, customTitle: string) => {
    transport.send({ type: 'renameAgent', id, customTitle });
  }, []);

  const handleClick = useCallback(
    (agentId: number) => {
      // If clicked agent is a sub-agent, focus the parent's terminal instead
      const os = getOfficeState();
      const meta = os.subagentMeta.get(agentId);
      // Sub-agent ids are webview-local; the ack must target the stable,
      // wire-meaningful parent id — same resolution as the focus logic below.
      const ackTarget = meta ? meta.parentAgentId : agentId;
      const clicked = os.characters.get(agentId);
      if (clicked?.crashed && !clicked.crashedAcknowledged) {
        os.acknowledgeCrash(ackTarget);
        transport.send({ type: 'acknowledgeCrash', id: ackTarget });
      }
      const focusId = meta ? meta.parentAgentId : agentId;
      transport.send({ type: 'focusAgent', id: focusId });
      // Browser runtime: also focus that agent's pane in the terminal band,
      // or start moving an outside session in (placeholder shows meanwhile).
      if (ptyBackedByAgent[focusId]) {
        setFocusedTerminalId(focusId);
      } else if (isMovable(focusId)) {
        setFocusedTerminalId(focusId);
        setTerminalOpen(true);
        requestMove(focusId);
      }
    },
    [ptyBackedByAgent, isMovable, requestMove, setTerminalOpen],
  );

  // Selection drives the band: selecting a character whose agent has a
  // terminal opens the band on it; deselecting (empty-floor click, same-agent
  // toggle, seat click) closes it. Terminal-less agents leave it untouched.
  const handleSelectionChange = useCallback(
    (selectedId: number | null) => {
      if (selectedId === null) {
        setTerminalOpen(false);
        return;
      }
      const os = getOfficeState();
      const meta = os.subagentMeta.get(selectedId);
      const resolved = meta ? meta.parentAgentId : selectedId;
      if (ptyBackedByAgent[resolved] || isMovable(resolved)) {
        setFocusedTerminalId(resolved);
        setTerminalOpen(true);
      }
    },
    [ptyBackedByAgent, isMovable, setTerminalOpen],
  );

  const officeState = getOfficeState();

  // Bump the focused agent's character on real pty bytes so it animates as
  // typing in real time (browser runtime only — focusedTerminalId stays null
  // otherwise, which the hook no-ops on).
  useCharacterPtyActivity(focusedTerminalId, ptyEventBus, officeState);

  // Merged set of folders the Areas dropdown can map: real workspace folders plus
  // every distinct folder an agent has run in this session (deduped by name; name
  // is the areaMappings key / seat-bias identity, path is only the React list key).
  const areaFolders = useMemo(() => {
    const byName = new Map<string, { name: string; path: string }>();
    for (const f of workspaceFolders) byName.set(f.name, f);
    for (const name of agentFolderNames) {
      if (!byName.has(name)) byName.set(name, { name, path: name });
    }
    return [...byName.values()];
  }, [workspaceFolders, agentFolderNames]);

  // Areas authoring is available when the layout already defines areas, or when
  // there is at least one mappable folder. Decouples the Areas UI from VS Code
  // multi-root workspaces (fixes single-root VS Code AND standalone, where
  // workspaceFolders is always empty).
  const areasAvailable = (officeState.getLayout().areas?.length ?? 0) > 0 || areaFolders.length > 0;

  const handleExportLayout = useCallback(() => {
    exportLayoutToFile(getOfficeState().getLayout());
  }, []);

  const handleImportLayout = useCallback(
    (file: File) => {
      // Browser-native import (standalone): read + validate + apply directly,
      // bypassing the layoutLoaded message whose dirty guard would skip it.
      if (
        isEditDirty() &&
        !window.confirm('Replace the current layout? Unsaved edits will be lost.')
      ) {
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const imported = JSON.parse(String(reader.result)) as Record<string, unknown>;
          // Match the VS Code guard, plus the furniture-array check VS Code omits
          // (migrate + rebuild iterate furniture and would throw on a non-array).
          if (
            imported.version !== 1 ||
            !Array.isArray(imported.tiles) ||
            !Array.isArray(imported.furniture)
          ) {
            window.alert('Invalid layout file.');
            return;
          }
          const migrated = migrateLayoutColors(imported as unknown as OfficeLayout);
          getOfficeState().rebuildFromLayout(migrated);
          editor.setLastSavedLayout(migrated);
          transport.send({
            type: 'saveLayout',
            layout: migrated as unknown as Record<string, unknown>,
          });
          editor.markClean();
        } catch {
          window.alert('Failed to read or parse layout file.');
        }
      };
      reader.readAsText(file);
    },
    [isEditDirty, editor],
  );

  // Force dependency on editorTickForKeyboard to propagate keyboard-triggered re-renders
  void editorTickForKeyboard;

  // Show "Press R to rotate" hint when a rotatable item is selected or being placed
  const showRotateHint =
    editor.isEditMode &&
    (() => {
      if (editorState.selectedFurnitureUid) {
        const item = officeState
          .getLayout()
          .furniture.find((f) => f.uid === editorState.selectedFurnitureUid);
        if (item && isRotatable(item.type)) return true;
      }
      if (
        editorState.activeTool === EditTool.FURNITURE_PLACE &&
        isRotatable(editorState.selectedFurnitureType)
      ) {
        return true;
      }
      return false;
    })();

  if (!layoutReady) {
    return <div className="w-full h-full flex items-center justify-center ">Loading...</div>;
  }

  // DOM order is [office, band]: column puts the band at the bottom, row puts
  // it on the right, row-reverse flips it to the left.
  const rootFlexDirection =
    panelPosition === 'bottom'
      ? 'flex-col'
      : panelPosition === 'left'
        ? 'flex-row-reverse'
        : 'flex-row';

  return (
    <div className={`w-full h-full flex ${rootFlexDirection}`}>
      <div ref={containerRef} className="flex-1 relative min-h-0 min-w-0 overflow-hidden">
        <OfficeCanvas
          officeState={officeState}
          onClick={handleClick}
          onSelectionChange={handleSelectionChange}
          isEditMode={editor.isEditMode}
          editorState={editorState}
          onEditorTileAction={editor.handleEditorTileAction}
          onEditorEraseAction={editor.handleEditorEraseAction}
          onEditorSelectionChange={editor.handleEditorSelectionChange}
          onDeleteSelected={editor.handleDeleteSelected}
          onRotateSelected={editor.handleRotateSelected}
          onDragMove={editor.handleDragMove}
          editorTick={editor.editorTick}
          zoom={editor.zoom}
          onZoomChange={editor.handleZoomChange}
          panRef={editor.panRef}
          showAreas={effectiveShowAreas}
          activeAreaLabel={activeAreaLabel}
          focusedAgentId={focusedTerminalId}
        />

        {!isDebugMode ? (
          <>
            <ZoomControls zoom={editor.zoom} onZoomChange={editor.handleZoomChange} />

            {/* Vignette overlay */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{ background: 'var(--vignette)' }}
            />

            {editor.isEditMode && editor.isDirty && (
              <EditActionBar editor={editor} editorState={editorState} />
            )}

            {showRotateHint && (
              <div
                className="absolute left-1/2 -translate-x-1/2 z-11 bg-accent-bright text-white text-sm py-3 px-8 rounded-none border-2 border-accent shadow-pixel pointer-events-none whitespace-nowrap"
                style={{ top: editor.isDirty ? 64 : 8 }}
              >
                Rotate (R)
              </div>
            )}

            {editor.isEditMode &&
              (() => {
                const selUid = editorState.selectedFurnitureUid;
                const selColor = selUid
                  ? (officeState.getLayout().furniture.find((f) => f.uid === selUid)?.color ?? null)
                  : null;
                return (
                  <EditorToolbar
                    activeTool={editorState.activeTool}
                    selectedTileType={editorState.selectedTileType}
                    selectedFurnitureType={editorState.selectedFurnitureType}
                    selectedFurnitureUid={selUid}
                    selectedFurnitureColor={selColor}
                    floorColor={editorState.floorColor}
                    wallColor={editorState.wallColor}
                    selectedWallSet={editorState.selectedWallSet}
                    onToolChange={editor.handleToolChange}
                    onTileTypeChange={editor.handleTileTypeChange}
                    onFloorColorChange={editor.handleFloorColorChange}
                    onWallColorChange={editor.handleWallColorChange}
                    onWallSetChange={editor.handleWallSetChange}
                    onSelectedFurnitureColorChange={editor.handleSelectedFurnitureColorChange}
                    pickedFurnitureColor={editorState.pickedFurnitureColor}
                    onPickedFurnitureColorChange={editor.handlePickedFurnitureColorChange}
                    onFurnitureTypeChange={editor.handleFurnitureTypeChange}
                    loadedAssets={loadedAssets}
                    activePetTypes={officeState.getActivePetTypes()}
                    petCount={getPetCount()}
                    onPetToggle={editor.handlePetToggle}
                    carpetVariant={editor.carpetVariant}
                    carpetColor={editor.carpetColor}
                    carpetAccentColor={editor.carpetAccentColor}
                    onCarpetVariantChange={editor.handleCarpetVariantChange}
                    onCarpetColorChange={editor.handleCarpetColorChange}
                    onCarpetAccentColorChange={editor.handleCarpetAccentColorChange}
                    areas={officeState.getLayout().areas ?? []}
                    selectedAreaLabel={editor.selectedAreaLabel}
                    workspaceFolders={areaFolders}
                    areasAvailable={areasAvailable}
                    areaMappings={areaMappings}
                    onSelectArea={editor.handleSelectArea}
                    onAddArea={editor.handleAddArea}
                    onRemoveArea={editor.handleRemoveArea}
                    onRenameArea={editor.handleRenameArea}
                    onAreaColorChange={editor.handleAreaColorChange}
                    onAreaMappingChange={handleAreaMappingChange}
                  />
                );
              })()}

            <ToolOverlay
              officeState={officeState}
              agents={agents}
              agentTools={agentTools}
              subagentTools={subagentTools}
              subagentCharacters={subagentCharacters}
              containerRef={containerRef}
              zoom={editor.zoom}
              panRef={editor.panRef}
              onCloseAgent={handleCloseAgent}
              alwaysShowOverlay={alwaysShowOverlay}
              /* Nameplates clear out while the layout editor is open — same
                 clean-canvas discipline as link lines and the crash glyph. */
              showNameplates={showNameplates && !editor.isEditMode}
              customTitles={customTitles}
              terminalNames={terminalNames}
            />
          </>
        ) : (
          <DebugView
            agents={agents}
            selectedAgent={selectedAgent}
            agentTools={agentTools}
            agentStatuses={agentStatuses}
            subagentTools={subagentTools}
            officeState={officeState}
            onSelectAgent={handleSelectAgent}
          />
        )}

        {/* Hooks first-run tooltip. Gated on hooksInstalled (the hooksStatus
          message), NOT the hooksEnabled preference: hooksEnabled defaults true
          while first-run consent is still pending, and announcing "Instant
          Detection Active" before anything is installed would be a lie. */}
        {hooksEnabled && claudeHooksInstalled && !hooksInfoShown && !hooksTooltipDismissed && (
          <Tooltip
            title="Instant Detection Active"
            position="top-right"
            onDismiss={() => {
              setHooksTooltipDismissed(true);
              transport.send({ type: 'setHooksInfoShown' });
            }}
          >
            <span className="text-sm text-text leading-none">
              Your agents now respond in real-time.{' '}
              <span
                className="text-accent cursor-pointer underline"
                onClick={() => {
                  setIsHooksInfoOpen(true);
                  setHooksTooltipDismissed(true);
                  transport.send({ type: 'setHooksInfoShown' });
                }}
              >
                View more
              </span>
            </span>
          </Tooltip>
        )}

        {/* Hooks info modal */}
        <Modal
          isOpen={isHooksInfoOpen}
          onClose={() => setIsHooksInfoOpen(false)}
          title="Instant Detection is ON"
          zIndex={52}
        >
          <div className="text-base text-text px-10" style={{ lineHeight: 1.4 }}>
            <p className="mb-8">Your Pixel Agents office now reacts in real-time:</p>
            <ul className="mb-8 pl-18 list-disc m-0">
              <li className="text-sm mb-2">Permission prompts appear instantly</li>
              <li className="text-sm mb-2">Turn completions detected the moment they happen</li>
              <li className="text-sm mb-2">Sound notifications play immediately</li>
            </ul>
            <p className="mb-12 text-text-muted">
              This works through Claude Code Hooks, small event listeners that notify Pixel Agents
              whenever something happens in your Claude sessions.
            </p>
            <div className="text-center">
              <button
                onClick={() => setIsHooksInfoOpen(false)}
                className="py-4 px-20 text-lg bg-accent text-white border-2 border-accent rounded-none cursor-pointer shadow-pixel"
              >
                Got it
              </button>
            </div>
            <p className="mt-8 text-xs text-text-muted text-center">
              To disable, go to Settings {'>'} Instant Detection
            </p>
          </div>
        </Modal>

        <BottomToolbar
          isEditMode={editor.isEditMode}
          onOpenClaude={editor.handleOpenClaude}
          onToggleEditMode={editor.handleToggleEditMode}
          isSettingsOpen={isSettingsOpen}
          onToggleSettings={() => setIsSettingsOpen((v) => !v)}
          workspaceFolders={workspaceFolders}
          onOpenNewAgent={() => setIsNewAgentOpen(true)}
        />

        <NewAgentModal
          isOpen={isNewAgentOpen}
          failure={launchAgentFailure}
          recentFolders={recentAgentFolders}
          onSpawn={(spawn) => {
            pendingSpawnOpenRef.current = true;
            transport.send({ type: 'launchAgent', ...spawn });
            setIsNewAgentOpen(false);
          }}
          onClose={() => {
            // Abandoning the form disarms any pending spawn auto-open.
            pendingSpawnOpenRef.current = false;
            setIsNewAgentOpen(false);
          }}
        />

        <VersionIndicator
          currentVersion={extensionVersion}
          lastSeenVersion={lastSeenVersion}
          onDismiss={handleWhatsNewDismiss}
          onOpenChangelog={handleOpenChangelog}
        />

        <ConnectionIndicator />

        <ChangelogModal
          isOpen={isChangelogOpen}
          onClose={() => setIsChangelogOpen(false)}
          currentVersion={extensionVersion}
        />

        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          isDebugMode={isDebugMode}
          onToggleDebugMode={handleToggleDebugMode}
          alwaysShowOverlay={alwaysShowOverlay}
          onToggleAlwaysShowOverlay={handleToggleAlwaysShowOverlay}
          showNameplates={showNameplates}
          onToggleShowNameplates={handleToggleShowNameplates}
          panelPosition={panelPosition}
          onChangePanelPosition={handleChangePanelPosition}
          ghostHeadlessAgents={ghostHeadlessAgents}
          onToggleGhostHeadlessAgents={handleToggleGhostHeadlessAgents}
          externalAssetDirectories={externalAssetDirectories}
          watchAllSessions={watchAllSessions}
          onToggleWatchAllSessions={() => {
            const newVal = !watchAllSessions;
            setWatchAllSessions(newVal);
            transport.send({ type: 'setWatchAllSessions', enabled: newVal });
          }}
          hooksInstalled={claudeHooksInstalled}
          onToggleHooksEnabled={() => {
            // Toggle the DISPLAYED state (actual install), not the preference: when the two disagree — preference on,
            // nothing installed while consent is pending — toggling the preference would turn hooks OFF for a user
            // asking for ON. No optimistic local update either; both backends answer with the truthful hooksStatus this
            // checkbox renders, so it lands correct instead of flickering when an install fails. The providerId is
            // ECHOED from that row (never originated here), so nothing sends until the row has arrived.
            const [rowProviderId] =
              Object.entries(hooksInstalled).find(([id]) => id === 'claude') ?? [];
            if (rowProviderId !== undefined) {
              transport.send({
                type: 'setHooksEnabled',
                providerId: rowProviderId,
                enabled: !claudeHooksInstalled,
              });
            }
          }}
          showAreas={showAreas}
          onToggleShowAreas={onToggleShowAreas}
          showAreasAvailable={areasAvailable}
          onExportLayout={handleExportLayout}
          onImportLayout={handleImportLayout}
        />

        {showMigrationNotice && (
          <MigrationNotice onDismiss={() => setMigrationNoticeDismissed(true)} />
        )}

        {intro && (
          <IntroBubble
            officeState={officeState}
            headline={intro.headline}
            disclosure={intro.disclosure}
            containerRef={containerRef}
            zoom={editor.zoom}
            panRef={editor.panRef}
            installFailed={installFailed}
            installPending={installPending}
            onChoice={handleConsentChoice}
            onClose={handleIntroClose}
            escapeSuppressed={
              isSettingsOpen ||
              isChangelogOpen ||
              isHooksInfoOpen ||
              showMigrationNotice ||
              editor.isEditMode
            }
          />
        )}
      </div>
      {isBrowserRuntime && hasPrivilegedToken && railAgents.length > 0 && terminalOpen && (
        <TerminalBand
          agents={railAgents}
          focusedId={focusedTerminalId}
          onFocus={handleRailFocus}
          onClose={handleCloseAgent}
          onRestartAgent={(id) => transport.send({ type: 'restartAgent', id })}
          onRename={handleRenameAgent}
          bus={ptyEventBus}
          position={panelPosition}
        />
      )}
    </div>
  );
}

export default App;
