import React, { useState, useRef, useEffect } from 'react';
import { importDictionaryWords, verifyAllLibraries, LibraryVerificationResult, DICTIONARY_CONFIG, fetchLocalWordList } from '../services/dataService';

// Use centralized dictionary config
const DICTIONARIES = DICTIONARY_CONFIG;

// Completeness threshold - library must have at least this % of words to be "installed"
const COMPLETENESS_THRESHOLD = 90;

interface LibrarySelectorProps {
    selectedLibraries: Set<string>;
    onChange: (libraries: Set<string>) => void;
    availableLibraries: string[];
    userId: string;
    onImportComplete: () => void;
}

export const LibrarySelector: React.FC<LibrarySelectorProps> = ({ 
    selectedLibraries, 
    onChange,
    availableLibraries,
    userId,
    onImportComplete
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const [downloadStatus, setDownloadStatus] = useState<Record<string, 'idle' | 'loading' | 'success' | 'error'>>({});
    
    // Track verified library status (full verification results)
    const [verifiedLibraries, setVerifiedLibraries] = useState<Record<string, LibraryVerificationResult>>({});
    const [isVerifying, setIsVerifying] = useState(false);

    // Verify library completeness on mount and when availableLibraries changes
    useEffect(() => {
        const verifyLibraries = async () => {
            if (!userId) return;
            
            setIsVerifying(true);
            try {
                // Use full verification that compares with GitHub source
                const results = await verifyAllLibraries(userId);
                setVerifiedLibraries(results);
                console.log('[LibrarySelector] Verified library completeness:', results);
            } catch (e) {
                console.error('[LibrarySelector] Failed to verify libraries:', e);
            } finally {
                setIsVerifying(false);
            }
        };
        
        verifyLibraries();
    }, [userId, availableLibraries]);

    // Close on click outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Helper: Check if a library is considered "installed" (complete enough)
    const isLibraryComplete = (tag: string): boolean => {
        const result = verifiedLibraries[tag];
        if (!result) return false;
        return result.completionRate >= COMPLETENESS_THRESHOLD;
    };

    // Auto-cleanup: Remove selected libraries that are no longer complete
    useEffect(() => {
        if (isVerifying) return; // Wait for verification to complete
        if (Object.keys(verifiedLibraries).length === 0) return; // No verification done yet
        
        const needsCleanup = Array.from(selectedLibraries).some((lib: string) => {
            if (lib === 'All' || lib === 'Custom') return false;
            // Check if this is a dictionary that is no longer complete
            const isDictionary = DICTIONARIES.some(d => d.tag === lib);
            if (isDictionary && !isLibraryComplete(lib)) {
                return true;
            }
            return false;
        });
        
        if (needsCleanup) {
            const cleanedSet = new Set<string>();
            selectedLibraries.forEach((lib: string) => {
                if (lib === 'All' || lib === 'Custom') {
                    cleanedSet.add(lib);
                } else if (isLibraryComplete(lib)) {
                    cleanedSet.add(lib);
                }
            });
            
            // Fallback to Custom if nothing left
            if (cleanedSet.size === 0) {
                cleanedSet.add('Custom');
            }
            
            console.log('[LibrarySelector] Cleaned up incomplete library selections:', 
                Array.from(selectedLibraries), '->', Array.from(cleanedSet));
            onChange(cleanedSet);
        }
    }, [verifiedLibraries, isVerifying, selectedLibraries, onChange]);

    const toggleLibrary = (lib: string) => {
        const newSet = new Set(selectedLibraries);
        
        if (lib === 'All') {
            if (newSet.has('All')) {
                newSet.clear();
                newSet.add('Custom'); // Default fallback
            } else {
                newSet.clear();
                newSet.add('All');
            }
        } else {
            if (newSet.has('All')) {
                newSet.delete('All');
                newSet.clear();
                newSet.add(lib);
            } else {
                if (newSet.has(lib)) {
                    newSet.delete(lib);
                } else {
                    newSet.add(lib);
                }
            }
        }
        
        if (newSet.size === 0) newSet.add('Custom');
        onChange(newSet);
    };

    const handleImport = async (e: React.MouseEvent, dict: typeof DICTIONARIES[0]) => {
        e.stopPropagation(); // Prevent toggling the dropdown item click
        if (downloadStatus[dict.tag] === 'loading') return;

        setDownloadStatus(prev => ({ ...prev, [dict.tag]: 'loading' }));
        try {
            // Fetch from local gold standard wordlist file
            const wordList = await fetchLocalWordList(dict.localPath);
            
            if (wordList.length === 0) {
                throw new Error(`Failed to load wordlist from ${dict.localPath}`);
            }

            console.log(`[LibrarySelector] Loaded ${wordList.length} words from ${dict.localPath} for ${dict.tag}`);

            await importDictionaryWords(userId, wordList, dict.tag);
            
            setDownloadStatus(prev => ({ ...prev, [dict.tag]: 'success' }));
            
            // Re-verify all libraries after import (full verification with source comparison)
            const results = await verifyAllLibraries(userId);
            setVerifiedLibraries(results);
            
            onImportComplete();
            
            // Automatically select the new library
            toggleLibrary(dict.tag);

        } catch (e) {
            console.error(e);
            setDownloadStatus(prev => ({ ...prev, [dict.tag]: 'error' }));
        }
    };

    const isAll = selectedLibraries.has('All');
    
    // Filter installed dictionaries (those with >= COMPLETENESS_THRESHOLD)
    const installedDictionaries = DICTIONARIES.filter(d => isLibraryComplete(d.tag));
    const installedDictTags = new Set(installedDictionaries.map(d => d.tag));
    
    // Incomplete dictionaries - have some words but not complete
    const incompleteDictionaries = DICTIONARIES.filter(d => {
        const result = verifiedLibraries[d.tag];
        return result && result.completionRate > 0 && result.completionRate < COMPLETENESS_THRESHOLD;
    });
    
    // Uninstalled dictionaries - no words at all
    const uninstalledDictionaries = DICTIONARIES.filter(d => {
        const result = verifiedLibraries[d.tag];
        return !result || result.status === 'empty' || result.completionRate === 0;
    });
    
    // Custom is always available if there are custom words
    const hasCustomWords = availableLibraries.includes('Custom');
    
    // Build the final installed set: Custom + installed dictionaries
    const installedSet = new Set<string>();
    if (hasCustomWords) {
        installedSet.add('Custom');
    }
    installedDictionaries.forEach(d => installedSet.add(d.tag));
    
    // Map installed tags to display names if possible
    const getDisplayName = (tag: string) => {
        const found = DICTIONARIES.find(d => d.tag === tag);
        return found ? found.name : tag;
    };

    return (
        <div className={`bg-light-charcoal p-5 rounded-2xl border border-mid-charcoal shadow-lg mb-6`} ref={dropdownRef}>
             <h3 className="font-headline text-xl text-electric-blue mb-4 flex items-center gap-2">
                <span className="material-symbols-outlined">library_books</span>
                LIBRARIES
                {isVerifying && (
                    <span className="material-symbols-outlined text-sm text-mid-grey animate-spin">refresh</span>
                )}
            </h3>
            
            <div className="relative">
                <button 
                    onClick={() => setIsOpen(!isOpen)}
                    className="w-full bg-dark-charcoal border border-mid-charcoal hover:border-electric-blue rounded-lg px-4 py-3 text-white text-left flex justify-between items-center transition-colors"
                >
                    <span className="truncate pr-2 font-mono">
                        {isAll ? "All Libraries" : Array.from(selectedLibraries).filter((lib: string) => lib === 'Custom' || isLibraryComplete(lib)).map(getDisplayName).join(', ') || 'Custom'}
                    </span>
                    <span className="material-symbols-outlined text-mid-grey">
                        {isOpen ? 'expand_less' : 'expand_more'}
                    </span>
                </button>

                {isOpen && (
                    <div className="absolute top-full left-0 right-0 mt-2 bg-mid-charcoal border border-mid-charcoal rounded-lg shadow-xl z-50 overflow-hidden max-h-80 overflow-y-auto">
                        <div className="p-2 space-y-1">
                            {/* All Libraries Option */}
                            <label className="flex items-center p-2 hover:bg-dark-charcoal rounded cursor-pointer group">
                                <input 
                                    type="checkbox" 
                                    checked={isAll}
                                    onChange={() => toggleLibrary('All')}
                                    className="w-4 h-4 rounded border-mid-grey bg-transparent text-electric-blue focus:ring-0 focus:ring-offset-0"
                                />
                                <span className={`ml-3 font-mono ${isAll ? 'text-white' : 'text-mid-grey group-hover:text-white'}`}>
                                    All Libraries
                                </span>
                            </label>
                            
                            <div className="h-px bg-mid-charcoal my-1 opacity-50"></div>

                            {/* Installed Libraries - Use verified installedSet */}
                            {Array.from(installedSet).filter(l => l !== 'All').map(lib => {
                                const result = verifiedLibraries[lib];
                                const isDictionary = DICTIONARIES.some(d => d.tag === lib);
                                
                                return (
                                    <label key={lib} className="flex items-center p-2 hover:bg-dark-charcoal rounded cursor-pointer group">
                                        <input 
                                            type="checkbox" 
                                            checked={selectedLibraries.has(lib)}
                                            onChange={() => toggleLibrary(lib)}
                                            className={`w-4 h-4 rounded border-mid-grey bg-transparent text-electric-blue focus:ring-0 focus:ring-offset-0`}
                                        />
                                        <div className="ml-3 flex flex-col">
                                            <span className={`font-mono ${selectedLibraries.has(lib) ? 'text-white' : 'text-mid-grey group-hover:text-white'}`}>
                                                {getDisplayName(lib)}
                                            </span>
                                            {isDictionary && result && (
                                                <span className="text-xs text-mid-grey">
                                                    {result.userWordCount.toLocaleString()}/{result.sourceWordCount.toLocaleString()} 词 ({result.completionRate}%)
                                                </span>
                                            )}
                                        </div>
                                        {/* Show checkmark if complete */}
                                        {isDictionary && (
                                            <span className="ml-auto material-symbols-outlined text-sm text-green-400">check_circle</span>
                                        )}
                                    </label>
                                );
                            })}

                            {/* Incomplete Libraries - need re-download */}
                            {incompleteDictionaries.length > 0 && (
                                <>
                                    <div className="h-px bg-mid-charcoal my-1 opacity-50"></div>
                                    <div className="px-2 py-1 text-xs text-yellow-500 font-bold uppercase tracking-wider flex items-center gap-1">
                                        <span className="material-symbols-outlined text-sm">warning</span>
                                        Incomplete - Needs Re-download
                                    </div>
                                    
                                    {incompleteDictionaries.map(dict => {
                                        const isLoading = downloadStatus[dict.tag] === 'loading';
                                        const result = verifiedLibraries[dict.tag];
                                        
                                        return (
                                            <div 
                                                key={dict.tag} 
                                                className="flex items-center justify-between p-2 hover:bg-dark-charcoal rounded group transition-colors select-none opacity-80 hover:opacity-100 border-l-2 border-yellow-500"
                                            >
                                                <div className="flex flex-col ml-7">
                                                    <span className="font-mono text-yellow-400 group-hover:text-yellow-300 transition-colors">
                                                        {dict.name}
                                                    </span>
                                                    {result && (
                                                        <span className="text-xs text-mid-grey">
                                                            仅 {result.userWordCount}/{result.sourceWordCount} 词 ({result.completionRate}%)
                                                        </span>
                                                    )}
                                                </div>
                                                
                                                <button
                                                    onClick={(e) => handleImport(e, dict)}
                                                    disabled={isLoading}
                                                    className="ml-2 p-1 rounded hover:bg-yellow-500/20 text-yellow-400 hover:text-yellow-300 transition-colors group/btn"
                                                    title={isLoading ? "Downloading..." : "Re-download to complete"}
                                                >
                                                    <span className={`material-symbols-outlined text-lg ${isLoading ? 'animate-spin' : ''}`}>
                                                        {isLoading ? 'refresh' : 'sync'}
                                                    </span>
                                                </button>
                                            </div>
                                        );
                                    })}
                                </>
                            )}

                            {/* Uninstalled Dictionaries */}
                            {uninstalledDictionaries.length > 0 && (
                                <>
                                    <div className="h-px bg-mid-charcoal my-1 opacity-50"></div>
                                    <div className="px-2 py-1 text-xs text-mid-grey font-bold uppercase tracking-wider">Available for Download</div>
                                    
                                    {uninstalledDictionaries.map(dict => {
                                        const isLoading = downloadStatus[dict.tag] === 'loading';
                                        
                                        return (
                                            <div 
                                                key={dict.tag} 
                                                className="flex items-center justify-between p-2 hover:bg-dark-charcoal rounded group transition-colors select-none opacity-60 hover:opacity-100"
                                            >
                                                <div className="flex items-center">
                                                    <div className="w-4 h-4 rounded border border-mid-grey bg-transparent opacity-50 mr-3"></div>
                                                    <span className="font-mono text-mid-grey group-hover:text-white transition-colors">
                                                        {dict.name}
                                                    </span>
                                                </div>
                                                
                                                <button
                                                    onClick={(e) => handleImport(e, dict)}
                                                    disabled={isLoading}
                                                    className="ml-2 p-1 rounded hover:bg-electric-blue/20 text-mid-grey hover:text-electric-blue transition-colors group/btn"
                                                    title={isLoading ? "Downloading..." : "Download Dictionary"}
                                                >
                                                    <span className={`material-symbols-outlined text-lg ${isLoading ? 'animate-spin' : ''}`}>
                                                        {isLoading ? 'refresh' : 'download'}
                                                    </span>
                                                </button>
                                            </div>
                                        );
                                    })}
                                </>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
