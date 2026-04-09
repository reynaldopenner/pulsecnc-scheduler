'use strict';
const express = require('express');
const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────
const MAX_SEARCH_DAYS = 730; // Safety cap: never search more than 2 years forward/backward
const MINUTES_PER_DAY = 1440;

const DAY_MAP = {
    "Sunday": 0,    "Domingo": 0,
    "Monday": 1,    "Lunes": 1,
    "Tuesday": 2,   "Martes": 2,
    "Wednesday": 3, "Miércoles": 3, "Miercoles": 3,
    "Thursday": 4,  "Jueves": 4,
    "Friday": 5,    "Viernes": 5,
    "Saturday": 6,  "Sábado": 6, "Sabado": 6
};

// ─────────────────────────────────────────────
//  TIMEZONE HELPERS  (DST-safe via Intl)
// ─────────────────────────────────────────────

/**
 * Returns a plain object with the wall-clock fields for a UTC Date
 * in the given IANA timezone (e.g. "America/Chihuahua").
 * Falls back to a numeric-offset string like "UTC-6" when needed.
 */
function getShopFields(dateObj, timezone) {
    try {
        const fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            year:   'numeric', month:  '2-digit', day:    '2-digit',
            hour:   '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        });
        const parts = Object.fromEntries(fmt.formatToParts(dateObj).map(p => [p.type, p.value]));
        return {
            dateStr: `${parts.year}-${parts.month}-${parts.day}`,
            dayNum:  new Date(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`).getDay(),
            hour:    parseInt(parts.hour, 10)
        };
    } catch {
        // Fallback: raw numeric offset (legacy support)
        const offset = parseFloat(timezone) || 0;
        const local  = new Date(dateObj.getTime() + offset * 3_600_000);
        const iso    = local.toISOString();
        return {
            dateStr: iso.split('T')[0],
            dayNum:  local.getUTCDay(),
            hour:    local.getUTCHours()
        };
    }
}

// ─────────────────────────────────────────────
//  CALENDAR BUILDER
// ─────────────────────────────────────────────

/**
 * scheduleMap[dayNum][hour] = true  →  that hour slot is a working hour.
 * holidaysSet = Set of "YYYY-MM-DD" strings in shop-local time.
 */
function buildCalendars(workingHoursArray, holidaysArray, timezone) {
    const scheduleMap = {};
    for (let i = 0; i <= 6; i++) scheduleMap[i] = {};

    (workingHoursArray || []).forEach(wh => {
        const dayNum = DAY_MAP[wh.day];
        if (dayNum !== undefined) {
            scheduleMap[dayNum][wh.hour] = wh.active === true || wh.active === 'true';
        }
    });

    const holidaysSet = new Set();
    (holidaysArray || []).forEach(h => {
        const { dateStr } = getShopFields(new Date(h), timezone);
        holidaysSet.add(dateStr);
    });

    return { scheduleMap, holidaysSet };
}

// ─────────────────────────────────────────────
//  MACHINE BUSY INDEX
//  Pre-indexes all existing tasks per machine
//  so availability checks are O(log n) not O(n).
// ─────────────────────────────────────────────

function buildMachineIndex(existingTasks) {
    const index = {}; // machineName → sorted array of {s, e} in ms
    (existingTasks || []).forEach(task => {
        if (!task?.s || !task?.e || !task?.m) return;
        const s = new Date(task.s).getTime();
        const e = new Date(task.e).getTime();
        if (isNaN(s) || isNaN(e) || e <= s) return;
        if (!index[task.m]) index[task.m] = [];
        index[task.m].push({ s, e });
    });
    // Sort each machine's intervals by start time
    Object.values(index).forEach(arr => arr.sort((a, b) => a.s - b.s));
    return index;
}

/**
 * Returns true if machineName is busy at timeMs (exclusive end boundary).
 * Uses binary search on the pre-sorted interval list.
 *
 * FIX: The original code used `currentTime < end`, which meant a job ending
 * at T=600 would block the machine until 599 but allow a new job to start
 * at 600 — correct in intent. The real bug was that actualEnd was stored as
 * the *last consumed minute*, so the next job's start check at that same
 * minute would pass. We now store actualEnd as lastMinute + 1 minute (exclusive),
 * and this function correctly uses: busy if s <= timeMs < e.
 */
function isMachineBusy(machineName, timeMs, machineIndex) {
    const intervals = machineIndex[machineName];
    if (!intervals?.length) return false;

    // Binary search for the last interval that starts <= timeMs
    let lo = 0, hi = intervals.length - 1, found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (intervals[mid].s <= timeMs) { found = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    if (found === -1) return false;
    return timeMs < intervals[found].e; // exclusive end
}

// ─────────────────────────────────────────────
//  LABOR MAP BUILDER
// ─────────────────────────────────────────────

function buildLaborMap(existingTasks, scheduleMap, holidaysSet, timezone) {
    const laborMap = {};
    (existingTasks || []).forEach(task => {
        if (!task?.s || !task?.e) return;
        let current = new Date(task.s).getTime();
        const end   = new Date(task.e).getTime();
        while (current < end) {
            const { dateStr, dayNum, hour } = getShopFields(new Date(current), timezone);
            if (!holidaysSet.has(dateStr) && scheduleMap[dayNum]?.[hour] === true) {
                laborMap[dateStr] = (laborMap[dateStr] || 0) + 1;
            }
            current += 60_000;
        }
    });
    return laborMap;
}

// ─────────────────────────────────────────────
//  SLOT JUMPING HELPERS
//  Instead of ticking minute-by-minute through
//  nights / weekends / holidays, we jump directly
//  to the next valid slot. This makes scheduling
//  of long gaps (weekends, holidays) near-instant.
// ─────────────────────────────────────────────

/**
 * Starting from timeMs, jump forward to the next minute that is:
 *   - not a holiday
 *   - in a working hour
 *   - machine not busy
 *   - labor not full
 * Returns the found timeMs, or null if MAX_SEARCH_DAYS exceeded.
 */
function nextAvailableForward(timeMs, machineName, machineIndex, scheduleMap, holidaysSet, timezone, laborMap, laborLimit) {
    const cap = timeMs + MAX_SEARCH_DAYS * MINUTES_PER_DAY * 60_000;
    let t = timeMs;
    while (t <= cap) {
        const { dateStr, dayNum, hour } = getShopFields(new Date(t), timezone);
        if (holidaysSet.has(dateStr)) {
            // Skip to midnight of next day
            t = startOfNextDay(t, timezone); continue;
        }
        if (scheduleMap[dayNum]?.[hour] !== true) {
            // Skip to next working hour
            t = nextWorkingHour(t, dayNum, hour, scheduleMap, timezone); continue;
        }
        if (isMachineBusy(machineName, t, machineIndex)) {
            t += 60_000; continue;
        }
        if ((laborMap[dateStr] || 0) >= laborLimit) {
            t = startOfNextDay(t, timezone); continue;
        }
        return t;
    }
    return null; // Unreachable in practice with a valid schedule
}

/**
 * Same logic but stepping backward.
 */
function nextAvailableBackward(timeMs, machineName, machineIndex, scheduleMap, holidaysSet, timezone, laborMap, laborLimit) {
    const cap = timeMs - MAX_SEARCH_DAYS * MINUTES_PER_DAY * 60_000;
    let t = timeMs;
    while (t >= cap) {
        const { dateStr, dayNum, hour } = getShopFields(new Date(t), timezone);
        if (holidaysSet.has(dateStr)) {
            t = endOfPrevDay(t, timezone); continue;
        }
        if (scheduleMap[dayNum]?.[hour] !== true) {
            t = prevWorkingHour(t, dayNum, hour, scheduleMap, timezone); continue;
        }
        if (isMachineBusy(machineName, t, machineIndex)) {
            t -= 60_000; continue;
        }
        if ((laborMap[dateStr] || 0) >= laborLimit) {
            t = endOfPrevDay(t, timezone); continue;
        }
        return t;
    }
    return null;
}

// Jump to 00:00 of the next calendar day in shop timezone
function startOfNextDay(timeMs, timezone) {
    const d = new Date(timeMs);
    const { dateStr } = getShopFields(d, timezone);
    // Add one day to the dateStr and find the UTC equivalent of midnight there
    const nextDate = new Date(dateStr);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    // We want the first minute of that date in shop time — approximate by adding 24h
    // then walking forward. This is close enough; the availability check will handle DST.
    return timeMs + 24 * 3_600_000;
}

// Jump to 23:59 of the previous calendar day
function endOfPrevDay(timeMs, timezone) {
    return timeMs - 24 * 3_600_000;
}

// Jump forward to the start of the next hour slot that is a working hour
function nextWorkingHour(timeMs, dayNum, hour, scheduleMap, timezone) {
    // Try subsequent hours in the same day, then next days
    let t = timeMs + 60_000; // advance at least 1 minute
    // Round up to next full hour
    const ms = new Date(t);
    ms.setMinutes(0, 0, 0);
    t = ms.getTime() + 3_600_000; // next full hour
    return t;
}

// Jump backward to the end of the previous working hour
function prevWorkingHour(timeMs, dayNum, hour, scheduleMap, timezone) {
    let t = timeMs - 60_000;
    const ms = new Date(t);
    ms.setMinutes(59, 0, 0);
    t = ms.getTime() - 3_600_000;
    return t;
}

// ─────────────────────────────────────────────
//  FORWARD SIMULATION
// ─────────────────────────────────────────────

function simulateForward(machineName, op, startMs, scheduleMap, holidaysSet, timezone, machineIndex, dailyLaborMap, laborLimit) {
    const simLaborMap = { ...dailyLaborMap };
    let minutesLeft = Math.ceil(op.setup_time + op.run_time);

    // Find the first available slot to START
    let t = nextAvailableForward(startMs, machineName, machineIndex, scheduleMap, holidaysSet, timezone, simLaborMap, laborLimit);
    if (t === null) throw new Error(`No available slot found for machine ${machineName}`);

    const actualStartMs = t;

    // Consume minutes
    while (minutesLeft > 0) {
        const { dateStr, dayNum, hour } = getShopFields(new Date(t), timezone);
        if (
            !holidaysSet.has(dateStr) &&
            scheduleMap[dayNum]?.[hour] === true &&
            !isMachineBusy(machineName, t, machineIndex) &&
            (simLaborMap[dateStr] || 0) < laborLimit
        ) {
            simLaborMap[dateStr] = (simLaborMap[dateStr] || 0) + 1;
            minutesLeft--;
            if (minutesLeft === 0) break;
        }
        t += 60_000;
        // Jump over non-working gaps to speed things up
        const next = nextAvailableForward(t, machineName, machineIndex, scheduleMap, holidaysSet, timezone, simLaborMap, laborLimit);
        if (next === null) throw new Error(`Ran out of available slots on machine ${machineName}`);
        t = next;
    }

    // FIX: actualEnd is t + 1 minute (exclusive boundary) so the next job
    // cannot start at the same minute this one ends on.
    return {
        machine:       machineName,
        actualStartMs,
        actualEndMs:   t + 60_000,   // <── EXCLUSIVE end
        finalLaborMap: simLaborMap
    };
}

// ─────────────────────────────────────────────
//  BACKWARD SIMULATION
// ─────────────────────────────────────────────

function simulateBackward(machineName, op, endMs, scheduleMap, holidaysSet, timezone, machineIndex, dailyLaborMap, laborLimit) {
    const simLaborMap = { ...dailyLaborMap };
    let minutesLeft = Math.ceil(op.setup_time + op.run_time);

    // Find the last available slot to END (step back from deadline)
    let t = nextAvailableBackward(endMs - 60_000, machineName, machineIndex, scheduleMap, holidaysSet, timezone, simLaborMap, laborLimit);
    if (t === null) throw new Error(`No available slot found for machine ${machineName}`);

    // FIX: actualEnd is the slot AFTER the last consumed minute (exclusive)
    const actualEndMs = t + 60_000;

    // Consume minutes backwards
    while (minutesLeft > 0) {
        const { dateStr, dayNum, hour } = getShopFields(new Date(t), timezone);
        if (
            !holidaysSet.has(dateStr) &&
            scheduleMap[dayNum]?.[hour] === true &&
            !isMachineBusy(machineName, t, machineIndex) &&
            (simLaborMap[dateStr] || 0) < laborLimit
        ) {
            simLaborMap[dateStr] = (simLaborMap[dateStr] || 0) + 1;
            minutesLeft--;
            if (minutesLeft === 0) break;
        }
        t -= 60_000;
        const prev = nextAvailableBackward(t, machineName, machineIndex, scheduleMap, holidaysSet, timezone, simLaborMap, laborLimit);
        if (prev === null) throw new Error(`Ran out of available slots on machine ${machineName}`);
        t = prev;
    }

    return {
        machine:       machineName,
        actualStartMs: t,            // inclusive start
        actualEndMs,                 // exclusive end
        finalLaborMap: simLaborMap
    };
}

// ─────────────────────────────────────────────
//  INPUT VALIDATION
// ─────────────────────────────────────────────

function validateOperation(op, index) {
    const errors = [];
    if (op.sequence === undefined || isNaN(Number(op.sequence)))
        errors.push(`Operation at index ${index} has invalid sequence`);
    if (op.setup_time === undefined || isNaN(Number(op.setup_time)) || Number(op.setup_time) < 0)
        errors.push(`Operation ${op.sequence ?? index} has invalid setup_time`);
    if (op.run_time === undefined || isNaN(Number(op.run_time)) || Number(op.run_time) <= 0)
        errors.push(`Operation ${op.sequence ?? index} has invalid run_time (must be > 0)`);
    if (!op.eligible_machines || String(op.eligible_machines).trim() === '')
        errors.push(`Operation ${op.sequence ?? index} has no eligible_machines`);
    return errors;
}

// ─────────────────────────────────────────────
//  MAIN ENDPOINT
// ─────────────────────────────────────────────

app.post('/api/schedule', (req, res) => {
    const {
        job_id, schedule_mode, start_date, target_date,
        operations, working_hours, holidays,
        timezone,        // preferred: IANA string e.g. "America/Chihuahua"
        tz_offset,       // legacy fallback: numeric e.g. -6
        daily_labor_minutes, existing_tasks
    } = req.body;

    // ── Validate start_date ──
    const rootStartMs = new Date(start_date).getTime();
    if (isNaN(rootStartMs))
        return res.status(400).json({ status: 'error', message: 'Invalid start_date' });

    // ── Validate operations ──
    if (!Array.isArray(operations) || operations.length === 0)
        return res.status(400).json({ status: 'error', message: 'operations must be a non-empty array' });

    const validationErrors = operations.flatMap((op, i) => validateOperation(op, i));
    if (validationErrors.length > 0)
        return res.status(400).json({ status: 'error', message: validationErrors.join('; ') });

    // ── Resolve timezone ──
    // Accept either an IANA string ("America/Chihuahua") or the legacy numeric offset.
    const tz = timezone || (tz_offset !== undefined ? String(tz_offset) : 'UTC');

    const laborLimit = Number(daily_labor_minutes) || 999_999;
    const mode = schedule_mode === 'backward' ? 'backward' : 'forward';
    const baseTasks = Array.isArray(existing_tasks) ? [...existing_tasks] : [];

    console.log(`\n─── SCHEDULE REQUEST | job: ${job_id} | mode: ${mode.toUpperCase()} | tz: ${tz} ───`);

    // ── Build calendars and indexes ──
    const { scheduleMap, holidaysSet } = buildCalendars(working_hours, holidays, tz);
    let machineIndex  = buildMachineIndex(baseTasks);
    let dailyLaborMap = buildLaborMap(baseTasks, scheduleMap, holidaysSet, tz);

    let scheduledOperations = [];
    let isImpossibleDeadline = false;

    try {
        // ══════════════════════════════════
        //  BACKWARD SCHEDULING
        // ══════════════════════════════════
        if (mode === 'backward') {
            const deadlineMs = new Date(target_date).getTime();
            if (isNaN(deadlineMs))
                return res.status(400).json({ status: 'error', message: 'backward scheduling requires a valid target_date' });

            const reverseOps = [...operations].sort((a, b) => b.sequence - a.sequence);
            let currentMs = deadlineMs;

            for (const op of reverseOps) {
                const machinesToTest = op.eligible_machines.split(',').map(m => m.trim()).filter(Boolean);
                let bestResult = null;

                for (const machine of machinesToTest) {
                    try {
                        const sim = simulateBackward(machine, op, currentMs, scheduleMap, holidaysSet, tz, machineIndex, dailyLaborMap, laborLimit);
                        // Pick the machine whose start is LATEST (closest to deadline = least idle time)
                        if (!bestResult || sim.actualStartMs > bestResult.actualStartMs) bestResult = sim;
                    } catch (e) {
                        console.warn(`  Skipping machine ${machine} for op ${op.sequence}: ${e.message}`);
                    }
                }

                if (!bestResult) throw new Error(`No machine could be scheduled for operation ${op.sequence}`);

                scheduledOperations.push({
                    operation_id:     op.id,
                    sequence:         op.sequence,
                    work_center:      bestResult.machine,
                    scheduled_start:  new Date(bestResult.actualStartMs).toISOString(),
                    scheduled_end:    new Date(bestResult.actualEndMs).toISOString()
                });

                // Register this task in the index so subsequent operations
                // in the same call see it as blocked time
                const newTask = {
                    m: bestResult.machine,
                    s: new Date(bestResult.actualStartMs).toISOString(),
                    e: new Date(bestResult.actualEndMs).toISOString()
                };
                baseTasks.push(newTask);
                machineIndex  = buildMachineIndex(baseTasks); // rebuild with new task
                dailyLaborMap = bestResult.finalLaborMap;
                currentMs     = bestResult.actualStartMs;
            }

            // Check if the result blew past the start date
            if (currentMs < rootStartMs) {
                console.log('  WARNING: Deadline impossible — triggering ASAP forward fallback.');
                isImpossibleDeadline = true;
                scheduledOperations  = [];
                // Reset to original DB tasks only
                machineIndex  = buildMachineIndex(existing_tasks || []);
                dailyLaborMap = buildLaborMap(existing_tasks || [], scheduleMap, holidaysSet, tz);
            } else {
                scheduledOperations.sort((a, b) => a.sequence - b.sequence);
            }
        }

        // ══════════════════════════════════
        //  FORWARD SCHEDULING  (or fallback)
        // ══════════════════════════════════
        if (mode === 'forward' || isImpossibleDeadline) {
            // Re-initialize with only DB tasks when running as fallback
            const forwardBaseTasks = isImpossibleDeadline
                ? [...(existing_tasks || [])]
                : baseTasks;

            if (isImpossibleDeadline) {
                machineIndex  = buildMachineIndex(forwardBaseTasks);
                dailyLaborMap = buildLaborMap(forwardBaseTasks, scheduleMap, holidaysSet, tz);
            }

            const forwardOps = [...operations].sort((a, b) => a.sequence - b.sequence);
            let currentMs    = rootStartMs;
            const runningTasks = [...forwardBaseTasks];

            for (const op of forwardOps) {
                const machinesToTest = op.eligible_machines.split(',').map(m => m.trim()).filter(Boolean);
                let bestResult = null;

                for (const machine of machinesToTest) {
                    try {
                        const sim = simulateForward(machine, op, currentMs, scheduleMap, holidaysSet, tz, machineIndex, dailyLaborMap, laborLimit);
                        // Pick the machine that finishes EARLIEST
                        if (!bestResult || sim.actualEndMs < bestResult.actualEndMs) bestResult = sim;
                    } catch (e) {
                        console.warn(`  Skipping machine ${machine} for op ${op.sequence}: ${e.message}`);
                    }
                }

                if (!bestResult) throw new Error(`No machine could be scheduled for operation ${op.sequence}`);

                scheduledOperations.push({
                    operation_id:     op.id,
                    sequence:         op.sequence,
                    work_center:      bestResult.machine,
                    scheduled_start:  new Date(bestResult.actualStartMs).toISOString(),
                    scheduled_end:    new Date(bestResult.actualEndMs).toISOString()
                });

                const newTask = {
                    m: bestResult.machine,
                    s: new Date(bestResult.actualStartMs).toISOString(),
                    e: new Date(bestResult.actualEndMs).toISOString()
                };
                runningTasks.push(newTask);
                machineIndex  = buildMachineIndex(runningTasks);
                dailyLaborMap = bestResult.finalLaborMap;
                currentMs     = bestResult.actualEndMs; // next op starts where this one ended
            }
        }

    } catch (err) {
        console.error('  SCHEDULER ERROR:', err.message);
        return res.status(500).json({ status: 'error', message: err.message, schedule: [] });
    }

    const lastOp = scheduledOperations[scheduledOperations.length - 1];
    console.log(`  ✓ Scheduled ${scheduledOperations.length} operations. Completion: ${lastOp?.scheduled_end}`);

    return res.json({
        job_id,
        status:                    isImpossibleDeadline ? 'warning_asap_fallback' : 'success',
        message:                   isImpossibleDeadline ? 'Deadline impossible. Scheduled ASAP.' : 'Scheduled successfully.',
        estimated_completion_date: lastOp?.scheduled_end ?? null,
        schedule:                  scheduledOperations
    });
});

// ─────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PulseCNC Enterprise Scheduler running on port ${PORT}`));