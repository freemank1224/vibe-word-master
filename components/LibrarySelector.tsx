import React, { useState, useRef, useEffect } from 'react';

interface LibrarySelectorProps {
    selectedLibraries: Set<string>;
    onChange: (libraries: Set<string>) => void;
    availableLibraries: string[];
}

export const LibrarySelector: React.FC<LibrarySelectorProps> = ({ 
    selectedLibraries, 
    onChange,
    availableLibraries 
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

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
            // Toggling All
            if (newSet.has('All')) {
                // If currently All, clicking it again resets to just 'Custom' (standard behavior)
                // Or clear everything? Let's go with Custom.
                newSet.clear();
                newSet.add('Custom');
            } else {
                newSet.clear();
                newSet.add('All');
            }
        } else {
            // Toggling specific
            if (newSet.has('All')) {
                newSet.delete('All');
                // When we remove All, we assume the user wants to start selecting specific ones.
                // It's intuitive to assume the one clicked is the ONE they want, 
                // but usually "All" implies "Everything selected".
                // Let's treat All as a special state that overrides others.
                // If All was selected, and user clicks 'Custom', the result is just 'Custom'.
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
        
        // Safety: If empty, default to Custom
        if (newSet.size === 0) newSet.add('Custom');
        
        onChange(newSet);
    };

    const isAll = selectedLibraries.has('All');
    
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
                        {isAll ? "All Libraries" : Array.from(selectedLibraries).join(', ')}
                    </span>
                    <span className="material-symbols-outlined text-mid-grey">
                        {isOpen ? 'expand_less' : 'expand_more'}
                    </span>
                </button>

                {isOpen && (
                    <div className="absolute top-full left-0 right-0 mt-2 bg-mid-charcoal border border-mid-charcoal rounded-lg shadow-xl z-50 overflow-hidden">
                        <div className="p-2 space-y-1 max-h-60 overflow-y-auto">
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

                            {availableLibraries.filter(l => l !== 'All').map(lib => (
                                <label key={lib} className="flex items-center p-2 hover:bg-dark-charcoal rounded cursor-pointer group">
                                    <input 
                                        type="checkbox" 
                                        checked={selectedLibraries.has(lib)}
                                        onChange={() => toggleLibrary(lib)}
                                        className={`w-4 h-4 rounded border-mid-grey bg-transparent text-electric-blue focus:ring-0 focus:ring-offset-0`}
                                    />
                                    <span className={`ml-3 font-mono ${selectedLibraries.has(lib) ? 'text-white' : 'text-mid-grey group-hover:text-white'}`}>
                                        {lib}
                                    </span>
                                </label>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
