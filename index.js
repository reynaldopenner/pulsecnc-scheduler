const express = require('express');
const app = express();
app.use(express.json());

// --- Timezone Configuration ---
// Central Standard Time is UTC-6. 
// (Change this to -7 or -5 depending on your exact region in Mexico)
const SHOP_TZ_OFFSET = -6; 

// Helper to translate Server Time to Physical Shop Time
function getShopTime(dateObj) {
    return new Date(dateObj.getTime() + (SHOP_TZ_OFFSET * 3600000));
}

// --- 1. HELPER FUNCTION: Build Virtual Calendars ---
function buildCalendars(workingHoursArray, holidaysArray) {
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
            scheduleMap[dayNum][wh.hour] = wh.active;
        }
    });

    const holidaysSet = new Set();
    if (holidaysArray) {
        holidaysArray.forEach(h => {
            // Shift the holiday to local time before extracting the date
            const shopHoliday = getShopTime(new Date(h));
            const dateStr = shopHoliday.toISOString().split('T')[0]; 
            holidaysSet.add(dateStr);
        });
    }

    return { scheduleMap, holidaysSet };
}

// --- 2. HELPER FUNCTION: The Calendar-Aware Clock ---
function calculateEndDate(startDateObj, totalMinutes, scheduleMap, holidaysSet) {
    let currentTime = new Date(startDateObj);
    let minutesLeft = totalMinutes;

    // Failsafe: Push clock forward until the shop opens
    while (true) {
        const shopTime = getShopTime(currentTime);
        const dateStr = shopTime.toISOString().split('T')[0];
        const isHoliday = holidaysSet.has(dateStr);
        
        // Evaluate the day and hour based on LOCAL time
        const dayNum = shopTime.getUTCDay();
        const hour = shopTime.getUTCHours();
        const isWorkingHour = scheduleMap[dayNum][hour] === true;
        
        if (!isHoliday && isWorkingHour) break; 
        currentTime.setMinutes(currentTime.getMinutes() + 1); 
    }

    // Step forward minute-by-minute
    while (minutesLeft > 0) {
        const shopTime = getShopTime(currentTime);
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
    
    return currentTime;
}

// --- 3. MAIN ENDPOINT ---
app.post('/api/schedule', (req, res) => {
    const { job_id, start_date, operations, working_hours, holidays } = req.body;
    
    operations.sort((a, b) => a.sequence - b.sequence);
    const { scheduleMap, holidaysSet } = buildCalendars(working_hours, holidays);

    let currentTime = new Date(start_date);
    const scheduledOperations = [];

    operations.forEach(op => {
        const totalMinutes = op.setup_time + op.run_time;
        const opStart = new Date(currentTime);
        const opEnd = calculateEndDate(opStart, totalMinutes, scheduleMap, holidaysSet);

        scheduledOperations.push({
            operation_id: op.id,
            sequence: op.sequence,
            work_center: op.work_center,
            scheduled_start: opStart.toISOString(),
            scheduled_end: opEnd.toISOString()
        });

        currentTime = new Date(opEnd); 
    });

    res.json({
        job_id: job_id,
        status: "success",
        estimated_completion_date: currentTime.toISOString(),
        schedule: scheduledOperations
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PulseCNC Scheduler running on port ${PORT}`));