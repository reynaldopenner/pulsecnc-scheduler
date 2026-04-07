const express = require('express');
const app = express();
app.use(express.json());

// Helper to translate Server Time to Physical Shop Time
function getShopTime(dateObj, tzOffsetHours) {
    return new Date(dateObj.getTime() + (tzOffsetHours * 3600000));
}

// 1. Build the base calendars
function buildCalendars(workingHoursArray, holidaysArray, tzOffsetHours) {
    const dayMap = { 
        "Sunday": 0, "Domingo": 0, "Monday": 1, "Lunes": 1, 
        "Tuesday": 2, "Martes": 2, "Wednesday": 3, "Miércoles": 3, "Miercoles": 3,
        "Thursday": 4, "Jueves": 4, "Friday": 5, "Viernes": 5, "Saturday": 6, "Sábado": 6, "Sabado": 6 
    };
    
    const scheduleMap = {};
    for(let i=0; i<=6; i++) scheduleMap[i] = {}; 

    if (workingHoursArray) {
        workingHoursArray.forEach(wh => {
            const dayNum = dayMap[wh.day];
            if (dayNum !== undefined) {
                scheduleMap[dayNum][wh.hour] = wh.active === true || wh.active === "true";
            }
        });
    }

    const holidaysSet = new Set();
    if (holidaysArray) {
        holidaysArray.forEach(h => {
            const shopHoliday = getShopTime(new Date(h), tzOffsetHours);
            const dateStr = shopHoliday.toISOString().split('T')[0]; 
            holidaysSet.add(dateStr);
        });
    }

    return { scheduleMap, holidaysSet };
}

// 2. NEW: Carve existing tasks into accurate Daily Labor Buckets
function buildLaborMap(existingTasks, scheduleMap, holidaysSet, tzOffsetHours) {
    const laborMap = {}; // Will look like: { '2026-04-08': 1200, '2026-04-09': 2400 }
    
    if (!existingTasks) return laborMap;

    existingTasks.forEach(task => {
        let current = new Date(task.s);
        const end = new Date(task.e);
        
        // Step through the existing task minute-by-minute
        while (current < end) {
            const shopTime = getShopTime(current, tzOffsetHours);
            const dateStr = shopTime.toISOString().split('T')[0];
            const dayNum = shopTime.getUTCDay();
            const hour = shopTime.getUTCHours();

            const isHoliday = holidaysSet.has(dateStr);
            const isWorkingHour = scheduleMap[dayNum][hour] === true;

            // Only count labor if the shop is actually open during this minute
            if (!isHoliday && isWorkingHour) {
                if (!laborMap[dateStr]) laborMap[dateStr] = 0;
                laborMap[dateStr]++;
            }
            current.setMinutes(current.getMinutes() + 1);
        }
    });
    return laborMap;
}

// 3. NEW: Check if the target machine is running an existing task right now
function isMachineBusy(machineName, currentTime, existingTasks) {
    if (!existingTasks) return false;
    return existingTasks.some(task => {
        const start = new Date(task.s);
        const end = new Date(task.e);
        return task.m === machineName && currentTime >= start && currentTime < end;
    });
}

// 4. The Finite Engine
function calculateOperationTimes(op, startDateObj, scheduleMap, holidaysSet, tzOffsetHours, existingTasks, dailyLaborMap, laborLimit) {
    let currentTime = new Date(startDateObj);
    let minutesLeft = Math.ceil(op.setup_time + op.run_time);

    // Failsafe: Push clock forward until Shop is Open, Machine is Free, AND Labor is available
    while (true) {
        const shopTime = getShopTime(currentTime, tzOffsetHours);
        const dateStr = shopTime.toISOString().split('T')[0];
        const dayNum = shopTime.getUTCDay();
        const hour = shopTime.getUTCHours();

        const isHoliday = holidaysSet.has(dateStr);
        const isWorkingHour = scheduleMap[dayNum][hour] === true;
        const machineBusy = isMachineBusy(op.work_center, currentTime, existingTasks);
        
        const currentDayLabor = dailyLaborMap[dateStr] || 0;
        const laborFull = currentDayLabor >= laborLimit;
        
        // If everything is green, we found our start time!
        if (!isHoliday && isWorkingHour && !machineBusy && !laborFull) break; 
        currentTime.setMinutes(currentTime.getMinutes() + 1); 
    }

    const actualStartTime = new Date(currentTime);

    // Step forward to calculate the finish time
    while (minutesLeft > 0) {
        const shopTime = getShopTime(currentTime, tzOffsetHours);
        const dateStr = shopTime.toISOString().split('T')[0];
        const dayNum = shopTime.getUTCDay();
        const hour = shopTime.getUTCHours();

        const isHoliday = holidaysSet.has(dateStr);
        const isWorkingHour = scheduleMap[dayNum][hour] === true;
        const machineBusy = isMachineBusy(op.work_center, currentTime, existingTasks);

        // We re-check labor because we might roll over into a brand new day while counting!
        const currentDayLabor = dailyLaborMap[dateStr] || 0;
        const laborFull = currentDayLabor >= laborLimit;

        if (!isHoliday && isWorkingHour && !machineBusy && !laborFull) {
            minutesLeft--; 
            
            // Add this minute to our labor bucket so we don't overbook the very next operation
            dailyLaborMap[dateStr] = currentDayLabor + 1;
        }
        
        if (minutesLeft > 0) {
            currentTime.setMinutes(currentTime.getMinutes() + 1);
        }
    }
    
    return {
        actualStart: actualStartTime,
        actualEnd: currentTime
    };
}

// --- MAIN ENDPOINT ---
app.post('/api/schedule', (req, res) => {
    const { job_id, start_date, operations, working_hours, holidays, tz_offset, daily_labor_minutes, existing_tasks } = req.body;
    
    const safeOffset = tz_offset !== undefined ? parseFloat(tz_offset) : 0;
    // Default to infinite capacity if you forget to send a limit from Bubble
    const laborLimit = daily_labor_minutes || 999999; 
    
    // Ensure existing_tasks is an array even if Bubble sends nothing
    const safeExistingTasks = existing_tasks || [];

    console.log(`\n--- FINITE SCHEDULING REQUEST: ${job_id} ---`);
    console.log(`Shop Labor Limit: ${laborLimit} minutes/day`);
    console.log(`Existing Tasks on Floor: ${safeExistingTasks.length}`);

    operations.sort((a, b) => a.sequence - b.sequence);
    
    const { scheduleMap, holidaysSet } = buildCalendars(working_hours, holidays, safeOffset);
    const dailyLaborMap = buildLaborMap(safeExistingTasks, scheduleMap, holidaysSet, safeOffset);

    let currentTime = new Date(start_date);
    const scheduledOperations = [];

    operations.forEach(op => {
        const proposedStart = new Date(currentTime);
        
        const times = calculateOperationTimes(op, proposedStart, scheduleMap, holidaysSet, safeOffset, safeExistingTasks, dailyLaborMap, laborLimit);

        scheduledOperations.push({
            operation_id: op.id,
            sequence: op.sequence,
            work_center: op.work_center,
            scheduled_start: times.actualStart.toISOString(),
            scheduled_end: times.actualEnd.toISOString()
        });

        // Add this newly scheduled op into the existing tasks array 
        // so Op 2 knows Op 1 is currently using the machine!
        safeExistingTasks.push({
            m: op.work_center,
            s: times.actualStart.toISOString(),
            e: times.actualEnd.toISOString(),
            t: op.setup_time + op.run_time
        });

        currentTime = new Date(times.actualEnd); 
    });

    console.log(`Successfully scheduled ${operations.length} operations.`);

    res.json({
        job_id: job_id,
        status: "success",
        estimated_completion_date: currentTime.toISOString(),
        schedule: scheduledOperations
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PulseCNC Finite Scheduler running on port ${PORT}`));