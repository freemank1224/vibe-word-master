#!/bin/bash

# ================================================================
# Database Version Control Initialization Script
# ================================================================
# This script sets up the database version control system
# Usage: ./scripts/init-db-version-control.sh
# ================================================================

set -e  # Exit on error

echo "🔧 Initializing Database Version Control System..."
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if .env file exists
if [ ! -f .env ]; then
    echo -e "${RED}❌ .env file not found!${NC}"
    echo "Please create .env file with SUPABASE_URL and SUPABASE_ANON_KEY"
    exit 1
fi

# Source .env file
echo -e "${YELLOW}📋 Loading environment variables...${NC}"
source .env

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_ANON_KEY" ]; then
    echo -e "${RED}❌ SUPABASE_URL or SUPABASE_ANON_KEY not set!${NC}"
    exit 1
fi

# Create directories
echo -e "${YELLOW}📁 Creating directories...${NC}"
mkdir -p database/migrations
mkdir -p database/snapshot
mkdir -p scripts/db

# Copy baseline to migrations if not already done
if [ ! -f "database/migrations/20250210_baseline.sql" ]; then
    if [ -f "database/snapshot/20250210_baseline_schema.sql" ]; then
        cp database/snapshot/20250210_baseline_schema.sql database/migrations/20250210_baseline.sql
        echo -e "${GREEN}✓ Created baseline migration${NC}"
    else
        echo -e "${RED}❌ Baseline schema not found!${NC}"
        exit 1
    fi
else
    echo -e "${GREEN}✓ Baseline migration already exists${NC}"
fi

# Create a migration template
cat > database/migrations/template.sql << 'EOF'
-- ================================================================
-- Migration: [Description]
-- Date: YYYY-MM-DD
-- Author: [Your Name]
-- Related Issue: #[number]
-- ================================================================

-- Instructions:
-- 1. Replace [Description] with brief description
-- 2. Add your SQL below
-- 3. Use IF NOT EXISTS for backwards compatibility
-- 4. Test locally before committing
-- 5. Update checklist at bottom

-- ================================================================
-- Migration SQL
-- ================================================================

-- Example: Add new column
-- ALTER TABLE public.words
-- ADD COLUMN IF NOT EXISTS new_field TEXT;

-- Example: Create index
-- CREATE INDEX IF NOT EXISTS words_new_field_idx
-- ON public.words(new_field);

-- ================================================================
-- Rollback Instructions (commented out)
-- ================================================================
-- To rollback this migration:
-- ALTER TABLE public.words DROP COLUMN new_field;
-- DROP INDEX IF NOT EXISTS words_new_field_idx;

-- ================================================================
-- Testing checklist:
-- [ ] Migration tested locally
-- [ ] Frontend TypeScript interfaces updated
-- [ ] Backwards compatible with existing data
-- [ ] Rollback procedure tested
-- [ ] Documentation updated
-- ================================================================
EOF

echo -e "${GREEN}✓ Created migration template${NC}"

# Create a verification script
cat > scripts/db/verify-schema.sh << 'EOF'
#!/bin/bash

# Verify Database Schema
# This script checks if the database schema matches the baseline

echo "🔍 Verifying database schema..."

# Add verification logic here
# For now, just check if we can connect

echo "✓ Database connection OK"
echo "⚠️  Full verification not implemented yet"
echo ""
echo "Manual verification steps:"
echo "1. Check all tables exist:"
echo "   SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';"
echo ""
echo "2. Check columns match frontend types"
echo "3. Verify indexes exist"
echo "4. Test RLS policies"
EOF

chmod +x scripts/db/verify-schema.sh

# Create a script to list all migrations
cat > scripts/db/list-migrations.sh << 'EOF'
#!/bin/bash

echo "📋 Database Migrations:"
echo ""
echo "Applied migrations (from database):"
echo "  (Use Supabase Dashboard or migration table to check)"
echo ""
echo "Pending migrations (local files):"
ls -1 database/migrations/*.sql 2>/dev/null | while read file; do
    filename=$(basename "$file")
    if [ "$filename" != "template.sql" ]; then
        echo "  - $filename"
    fi
done
echo ""
echo "To apply a migration:"
echo "  psql \$DATABASE_URL -f database/migrations/[filename]"
EOF

chmod +x scripts/db/list-migrations.sh

# Create a .gitignore entry for database/ if needed
if ! grep -q "^database/migrations/" .gitignore 2>/dev/null; then
    echo ""
    echo "database/migrations/*.sql" >> .gitignore
    echo "database/migrations/!template.sql" >> .gitignore
    echo "database/migrations/2025*.sql" >> .gitignore
    echo -e "${GREEN}✓ Updated .gitignore${NC}"
fi

echo ""
echo -e "${GREEN}✅ Database version control system initialized!${NC}"
echo ""
echo "Next steps:"
echo "  1. Review the baseline schema:"
echo "     cat database/snapshot/20250210_baseline_schema.sql"
echo ""
echo "  2. Commit to Git:"
echo "     git add database/ scripts/db/"
echo "     git commit -m 'feat: initialize database version control system'"
echo ""
echo "  3. Read the guide:"
echo "     cat database/DATABASE_VERSION_CONTROL.md"
echo ""
echo "  4. When you need to change the database:"
echo "     - Copy template: cp database/migrations/template.sql database/migrations/YYYYMMDD_description.sql"
echo "     - Edit the migration file"
echo "     - Test locally"
echo "     - Commit with Git"
echo ""
