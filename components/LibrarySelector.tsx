import React, { useState, useRef, useEffect } from 'react';
import { importDictionaryWords } from '../services/dataService';

const DICTIONARIES = [
    { name: 'Primary School (小学)', url: 'https://raw.githubusercontent.com/mahavivo/english-wordlists/master/%E5%B0%8F%E5%AD%A6%E8%8B%B1%E8%AF%AD%E5%A4%A7%E7%BA%B2%E8%AF%8D%E6%B1%87.txt', tag: 'Primary' },
    { name: 'Junior High (初中)', url: 'https://raw.githubusercontent.com/mahavivo/english-wordlists/master/%E4%B8%AD%E8%80%83%E8%8B%B1%E8%AF%AD%E8%AF%8D%E6%B1%87%E8%A1%A8.txt', tag: 'Junior' },
    { name: 'Senior High (高中)', url: 'https://raw.githubusercontent.com/mahavivo/english-wordlists/master/Highschool_edited.txt', tag: 'Senior' },
    { name: 'CET-4 (四级)', url: 'https://raw.githubusercontent.com/mahavivo/english-wordlists/master/CET4_edited.txt', tag: 'CET-4' },
    { name: 'CET-6 (六级)', url: 'https://raw.githubusercontent.com/mahavivo/english-wordlists/master/CET6_edited.txt', tag: 'CET-6' },
];

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
            const response = await fetch(dict.url);
            if (!response.ok) throw new Error('Fetch failed');
            
            const text = await response.text();
            let wordList: string[] = [];

            if (dict.tag === 'Primary' || dict.tag === 'Senior') {
                wordList = text.split('\n')
                               .map(l => l.trim())
                               .filter(l => l.length > 1 && !l.startsWith('#') && /^[a-zA-Z\s-]+$/.test(l));
            } else {
                wordList = text.split('\n')
                    .map(line => {
                        const match = line.match(/^([a-zA-Z]+)/);
                        return match ? match[1] : '';
                    })
                    .filter(w => w.length > 1);
            }

            console.log(`Parsed ${wordList.length} words for ${dict.tag}`);

            if (wordList.length > 0) {
                 await importDictionaryWords(userId, wordList, dict.tag);
            }
            
            setDownloadStatus(prev => ({ ...prev, [dict.tag]: 'success' }));
            onImportComplete();
            
            // Automatically select the new library
            toggleLibrary(dict.tag);

        } catch (e) {
            console.error(e);
            setDownloadStatus(prev => ({ ...prev, [dict.tag]: 'error' }));
        }
    };

    const isAll = selectedLibraries.has('All');
    
    // Determine which are installed and which are not
    const installedSet = new Set(availableLibraries);
    const uninstalledDictionaries = DICTIONARIES.filter(d => !installedSet.has(d.tag));
    
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
            </h3>
            
            <div className="relative">
                <button 
                    onClick={() => setIsOpen(!isOpen)}
                    className="w-full bg-dark-charcoal border border-mid-charcoal hover:border-electric-blue rounded-lg px-4 py-3 text-white text-left flex justify-between items-center transition-colors"
                >
                    <span className="truncate pr-2 font-mono">
                        {isAll ? "All Libraries" : Array.from(selectedLibraries).map(getDisplayName).join(', ')}
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

                            {/* Installed Libraries */}
                            {availableLibraries.filter(l => l !== 'All').map(lib => (
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
                                    </div>
                                    {/* Show checkmark if originally came from dict list but is installed */}
                                    {DICTIONARIES.some(d => d.tag === lib) && (
                                         <span className="ml-auto material-symbols-outlined text-sm text-green-400">check_circle</span>
                                    )}
                                </label>
                            ))}

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
