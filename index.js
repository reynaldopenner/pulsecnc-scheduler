const express = require('express');
const app = express();
app.use(express.json());

// Helper to translate Server Time to Physical Shop Time using the dynamic offset
function getShopTime(dateObj, tzOffsetHours) {
    return new Date(dateObj.getTime() + (tzOffsetHours * 3600000));
}

// --- 1. HELPER FUNCTION: Build Virtual Calendars ---
function buildCalendars(workingHoursArray, holidaysArray, tzOffsetHours) {
    const dayMap = { 
        "Sunday": 0, "Domingo": 0, 
        "Monday": 1, "Lunes": 1, 
        "Tuesday": 2, "Martes": 2, 
        "Wednesday": 3, "Miércoles": 3, "Miercoles": 3,
        "Thursday": 4, "Jueves": 4, 
        "Friday": 5, "Viernes": 5, 
        "Saturday": 6, "Sábado": 6, "Sabado": 6 
    };
    
    const scheduleMap = {};
    for(let i=0; i<=6; i++) scheduleMap[i] = {}; 

    workingHoursArray.forEach(wh => {
        const dayNum = dayMap[wh.day];
        if (dayNum !== undefined) {
            scheduleMap[dayNum][wh.hour] = wh.active === true || wh.active === "true";
        }
    });

    const holidaysSet = new Set();
    if (holidaysArray) {
        holidaysArray.forEach(h => {
            // Use the dynamic offset to map holidays correctly
            const shopHoliday = getShopTime(new Date(h), tzOffsetHours);
            const dateStr = shopHoliday.toISOString().split('T')[0]; 
            holidaysSet.add(dateStr);
        });
    }

    return { scheduleMap, holidaysSet };
}

// --- 2. HELPER FUNCTION: The Calendar-Aware Clock ---
function calculateOperationTimes(startDateObj, totalMinutes, scheduleMap, holidaysSet, tzOffsetHours) {
    let currentTime = new Date(startDateObj);
    let minutesLeft = Math.ceil(totalMinutes);

    while (true) {
        const shopTime = getShopTime(currentTime, tzOffsetHours);
        const dateStr = shopTime.toISOString().split('T')[0];
        const isHoliday = holidaysSet.has(dateStr);
        const dayNum = shopTime.getUTCDay();
        const hour = shopTime.getUTCHours();
        const isWorkingHour = scheduleMap[dayNum][hour] === true;
        
        if (!isHoliday && isWorkingHour) break; 
        currentTime.setMinutes(currentTime.getMinutes() + 1); 
    }

    const actualStartTime = new Date(currentTime);

    while (minutesLeft > 0) {
        const shopTime = getShopTime(currentTime, tzOffsetHours);
        const dateStr = shopTime.toISOString().split('T')[0];
        const dayNum = shopTime.getUTCDay();
        const hour = shopTime.getUTCHours();

        const isHoliday = holidaysSet.has(dateStr);
        const isWorkingHour = scheduleMap[dayNum][hour] === true;

        if (!isHoliday && isWorkingHour) {
            minutesLeft--; 
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

// --- 3. MAIN ENDPOINT ---
app.post('/api/schedule', (req, res) => {
    // 1. We now extract tz_offset from Bubble's payload!
    const { job_id, start_date, operations, working_hours, holidays, tz_offset } = req.body;
    
    // 2. Default to UTC (0) if the payload is missing the offset to prevent crashes
    const safeOffset = tz_offset !== undefined ? parseFloat(tz_offset) : 0;

    console.log(`\n--- NEW SCHEDULING REQUEST FOR JOB: ${job_id} ---`);
    console.log(`Calculated with Timezone Offset: ${safeOffset}`);

    operations.sort((a, b) => a.sequence - b.sequence);
    
    // Pass the offset down into our helper functions
    const { scheduleMap, holidaysSet } = buildCalendars(working_hours, holidays, safeOffset);

    let currentTime = new Date(start_date);
    const scheduledOperations = [];

    operations.forEach(op => {
        const totalMinutes = op.setup_time + op.run_time;
        const proposedStart = new Date(currentTime);
        
        const times = calculateOperationTimes(proposedStart, totalMinutes, scheduleMap, holidaysSet, safeOffset);

        scheduledOperations.push({
            operation_id: op.id,
            sequence: op.sequence,
            work_center: op.work_center,
            scheduled_start: times.actualStart.toISOString(),
            scheduled_end: times.actualEnd.toISOString()
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
app.listen(PORT, () => console.log(`PulseCNC Scheduler running on port ${PORT}`));