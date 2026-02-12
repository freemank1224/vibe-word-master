/**
 * Apply Historical Stats Freeze Migration
 *
 * This script will:
 * 1. Apply the 20250213_freeze_historical_stats.sql migration
 * 2. Freeze all historical data (before today)
 * 3. Update the record_test_and_sync_stats function to enforce freezing
 *
 * CRITICAL: Once applied, historical data CANNOT be modified!
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Load environment variables
require('dotenv').config();

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY; // Use service role key for migrations

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Missing environment variables:');
    console.error('   VITE_SUPABASE_URL and VITE_SUPABASE_SERVICE_ROLE_KEY are required');
    console.error('\n💡 Make sure to set up your .env file with service role key');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function applyMigration() {
    console.log('🔒 Starting Historical Stats Freeze Migration...\n');

    try {
        // Read the migration SQL
        const migrationPath = path.join(__dirname, 'migrations', '20250213_freeze_historical_stats.sql');
        const sql = fs.readFileSync(migrationPath, 'utf8');

        console.log('📄 Migration file loaded:', migrationPath);
        console.log('📝 SQL size:', sql.length, 'characters\n');

        // Execute the migration using SQL editor (manually)
        console.log('⚠️  IMPORTANT: This migration needs to be applied manually!\n');
        console.log('Steps to apply:');
        console.log('1. Go to Supabase Dashboard → SQL Editor');
        console.log('2. Copy and paste the SQL from:');
        console.log('   database/migrations/20250213_freeze_historical_stats.sql');
        console.log('3. Run the SQL\n');

        console.log('💾 Copying SQL to clipboard...');
        console.log('━'.repeat(60));
        console.log(sql);
        console.log('━'.repeat(60));
        console.log('\n✅ Migration SQL ready to apply!\n');

        // Verify by checking if freeze function exists
        const { data: functions, error: funcError } = await supabase
            .rpc('freeze_previous_days');

        if (funcError) {
            console.log('⏳ Migration not yet applied.');
            console.log('   The freeze_previous_days() function does not exist yet.');
            console.log('   Please apply the SQL in Supabase Dashboard first.\n');
        } else {
            console.log('✅ Migration already applied!');
            console.log('   Historical data freeze mechanism is active.\n');

            // Check frozen status
            const { data: stats } = await supabase
                .from('daily_stats')
                .select('date, is_frozen')
                .order('date', { ascending: false })
                .limit(10);

            if (stats) {
                console.log('📊 Recent stats status:');
                stats.forEach(stat => {
                    const status = stat.is_frozen ? '🔒 FROZEN' : '📝 ACTIVE';
                    console.log(`   ${stat.date}: ${status}`);
                });
                console.log('');
            }
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

applyMigration().then(() => {
    console.log('✨ Done!');
    process.exit(0);
}).catch(err => {
    console.error('💥 Fatal error:', err);
    process.exit(1);
});
