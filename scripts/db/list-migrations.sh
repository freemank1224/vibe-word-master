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
