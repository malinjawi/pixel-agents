import { useEffect, useRef, useState } from 'react';

import type { WorkspaceFolder } from '../hooks/useExtensionMessages.js';
import { vscode } from '../vscodeApi.js';
import { Button } from './ui/Button.js';
import { Dropdown, DropdownItem } from './ui/Dropdown.js';

interface BottomToolbarProps {
  isEditMode: boolean;
  onOpenClaude: () => void;
  onToggleEditMode: () => void;
  isSettingsOpen: boolean;
  onToggleSettings: () => void;
  workspaceFolders: WorkspaceFolder[];
}

export function BottomToolbar({
  isEditMode,
  onOpenClaude,
  onToggleEditMode,
  isSettingsOpen,
  onToggleSettings,
  workspaceFolders,
}: BottomToolbarProps) {
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);
  const [isBobFolderPickerOpen, setIsBobFolderPickerOpen] = useState(false);
  const [isBypassMenuOpen, setIsBypassMenuOpen] = useState(false);
  const folderPickerRef = useRef<HTMLDivElement>(null);
  const bobFolderPickerRef = useRef<HTMLDivElement>(null);
  const pendingBypassRef = useRef(false);
  // Close folder picker / bypass menu on outside click
  useEffect(() => {
    if (!isFolderPickerOpen && !isBobFolderPickerOpen && !isBypassMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (folderPickerRef.current && !folderPickerRef.current.contains(e.target as Node)) {
        setIsFolderPickerOpen(false);
        setIsBypassMenuOpen(false);
      }
      if (bobFolderPickerRef.current && !bobFolderPickerRef.current.contains(e.target as Node)) {
        setIsBobFolderPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isFolderPickerOpen, isBobFolderPickerOpen, isBypassMenuOpen]);

  const hasMultipleFolders = workspaceFolders.length > 1;

  const handleAgentClick = () => {
    setIsBypassMenuOpen(false);
    pendingBypassRef.current = false;
    if (hasMultipleFolders) {
      setIsFolderPickerOpen((v) => !v);
    } else {
      onOpenClaude();
    }
  };

  const handleAgentHover = () => {
    if (!isFolderPickerOpen) {
      setIsBypassMenuOpen(true);
    }
  };

  const handleAgentLeave = () => {
    if (!isFolderPickerOpen) {
      setIsBypassMenuOpen(false);
    }
  };

  const handleFolderSelect = (folder: WorkspaceFolder) => {
    setIsFolderPickerOpen(false);
    const bypassPermissions = pendingBypassRef.current;
    pendingBypassRef.current = false;
    vscode.postMessage({ type: 'openClaude', folderPath: folder.path, bypassPermissions });
  };

  const handleBobClick = () => {
    if (hasMultipleFolders) {
      setIsBypassMenuOpen(false);
      setIsFolderPickerOpen(false);
      setIsBobFolderPickerOpen((v) => !v);
    } else {
      vscode.postMessage({ type: 'openBob' });
    }
  };

  const handleBobFolderSelect = (folder: WorkspaceFolder) => {
    setIsBobFolderPickerOpen(false);
    vscode.postMessage({ type: 'openBob', folderPath: folder.path });
  };

  const handleBypassSelect = (bypassPermissions: boolean) => {
    setIsBypassMenuOpen(false);
    if (hasMultipleFolders) {
      pendingBypassRef.current = bypassPermissions;
      setIsFolderPickerOpen(true);
    } else {
      vscode.postMessage({ type: 'openClaude', bypassPermissions });
    }
  };

  return (
    <div className="absolute bottom-10 left-10 z-20 flex items-center gap-4 pixel-panel p-4">
      <div
        ref={folderPickerRef}
        className="relative"
        onMouseEnter={handleAgentHover}
        onMouseLeave={handleAgentLeave}
      >
        <Button
          variant="accent"
          onClick={handleAgentClick}
          className={
            isFolderPickerOpen || isBypassMenuOpen
              ? 'bg-accent-bright'
              : 'bg-accent hover:bg-accent-bright'
          }
        >
          + Claude
        </Button>
        <Dropdown isOpen={isBypassMenuOpen}>
          <DropdownItem onClick={() => handleBypassSelect(true)}>
            Skip permissions mode <span className="text-2xs text-warning">⚠</span>
          </DropdownItem>
        </Dropdown>
        <Dropdown isOpen={isFolderPickerOpen} className="min-w-128">
          {workspaceFolders.map((folder) => (
            <DropdownItem
              key={folder.path}
              onClick={() => handleFolderSelect(folder)}
              className="text-base"
            >
              {folder.name}
            </DropdownItem>
          ))}
        </Dropdown>
      </div>
      <div ref={bobFolderPickerRef} className="relative">
        <Button
          variant="accent"
          onClick={handleBobClick}
          className={
            isBobFolderPickerOpen ? 'bg-accent-bright' : 'bg-accent hover:bg-accent-bright'
          }
        >
          + Bob
        </Button>
        <Dropdown isOpen={isBobFolderPickerOpen} className="min-w-128">
          {workspaceFolders.map((folder) => (
            <DropdownItem
              key={folder.path}
              onClick={() => handleBobFolderSelect(folder)}
              className="text-base"
            >
              {folder.name}
            </DropdownItem>
          ))}
        </Dropdown>
      </div>
      <Button
        variant={isEditMode ? 'active' : 'default'}
        onClick={onToggleEditMode}
        title="Edit office layout"
      >
        Layout
      </Button>
      <Button
        variant={isSettingsOpen ? 'active' : 'default'}
        onClick={onToggleSettings}
        title="Settings"
      >
        Settings
      </Button>
    </div>
  );
}
