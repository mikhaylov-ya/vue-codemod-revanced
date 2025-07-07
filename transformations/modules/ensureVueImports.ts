import type { Collection, JSCodeshift } from "jscodeshift";

export function ensureVueImports(j: JSCodeshift, root: Collection<any>) {
        // Check if inject, ref, computed, and watch are imported from 'vue'
        const vueImports = root.find(j.ImportDeclaration, {
            source: { value: "vue" }
        });
        
        let hasInject = false;
        let hasRef = false;
        let hasComputed = false;
        let hasWatch = false;
        
        if (vueImports.length > 0) {
            vueImports.forEach(path => {
                const specifiers = path.value.specifiers;
                hasInject = hasInject || specifiers.some(spec => spec.type === 'ImportSpecifier' && spec.imported.name === 'inject');
                hasRef = hasRef || specifiers.some(spec => spec.type === 'ImportSpecifier' && spec.imported.name === 'ref');
                hasComputed = hasComputed || specifiers.some(spec => spec.type === 'ImportSpecifier' && spec.imported.name === 'computed');
                hasWatch = hasWatch || specifiers.some(spec => spec.type === 'ImportSpecifier' && spec.imported.name === 'watch');
            });
        }
        
        // Collect missing imports
        const missingImports = [];
        if (!hasInject) missingImports.push('inject');
        if (!hasRef) missingImports.push('ref');
        if (!hasComputed) missingImports.push('computed');
        if (!hasWatch) missingImports.push('watch');
        
        // Add missing imports
        if (missingImports.length > 0) {
            if (vueImports.length > 0) {
                // Add missing imports to existing vue import
                vueImports.forEach(path => {
                    const specifiers = path.value.specifiers;
                    missingImports.forEach(importName => {
                        specifiers.push(j.importSpecifier(j.identifier(importName)));
                    });
                });
            } else {
                // Create new vue import with all missing imports
                const importSpecifiers = missingImports.map(importName => 
                    j.importSpecifier(j.identifier(importName))
                );
                const newVueImport = j.importDeclaration(importSpecifiers, j.literal("vue"));
                
                // Add the import
                const firstImport = root.find(j.ImportDeclaration).at(0);
                if (firstImport.length > 0) {
                    firstImport.insertBefore(newVueImport);
                } else {
                    const program = root.find(j.Program);
                    if (program.length > 0) {
                        program.get('body', 0).insertBefore(newVueImport);
                    }
                }
            }            
        }
    }
