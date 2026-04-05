const express = require('express');
const app = express();
app.use(express.json());

const SHOP_TZ_OFFSET = -6; 

function getShopTime(dateObj) {
    return new Date(dateObj.getTime() + (SHOP_TZ_OFFSET * 3600000));
}

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
            scheduleMap[dayNum][wh.hour] = wh.active === true || wh.active === "true"; // Failsafe for Bubble booleans
        }
    });

    const holidaysSet = new Set();
    if (holidaysArray) {
        holidaysArray.forEach(h => {
            const shopHoliday = getShopTime(new Date(h));
            const dateStr = shopHoliday.toISOString().split('T')[0]; 
            holidaysSet.add(dateStr);
        });
    }

    return { scheduleMap, holidaysSet };
}

// --- 2. HELPER FUNCTION: The Calendar-Aware Clock ---
function calculateOperationTimes(startDateObj, totalMinutes, scheduleMap, holidaysSet) {
    let currentTime = new Date(startDateObj);
    let minutesLeft = Math.ceil(totalMinutes);

    // Failsafe: Push clock forward until the shop opens
    while (true) {
        const shopTime = getShopTime(currentTime);
        const dateStr = shopTime.toISOString().split('T')[0];
        const isHoliday = holidaysSet.has(dateStr);
        const dayNum = shopTime.getUTCDay();
        const hour = shopTime.getUTCHours();
        const isWorkingHour = scheduleMap[dayNum][hour] === true;
        
        if (!isHoliday && isWorkingHour) break; 
        currentTime.setMinutes(currentTime.getMinutes() + 1); 
    }

    // THE FIX: Record the actual start time AFTER we waited for the shop to open
    const actualStartTime = new Date(currentTime);

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
    
    return {
        actualStart: actualStartTime,
        actualEnd: currentTime
    };
}

// --- 3. MAIN ENDPOINT ---
app.post('/api/schedule', (req, res) => {
    const { job_id, start_date, operations, working_hours, holidays } = req.body;
    
    console.log(`\n--- NEW SCHEDULING REQUEST FOR JOB: ${job_id} ---`);

    operations.sort((a, b) => a.sequence - b.sequence);
    const { scheduleMap, holidaysSet } = buildCalendars(working_hours, holidays);

    let currentTime = new Date(start_date);
    const scheduledOperations = [];

    operations.forEach(op => {
        const totalMinutes = op.setup_time + op.run_time;
        const proposedStart = new Date(currentTime);
        
        // Run our updated function that returns both the real start and end times
        const times = calculateOperationTimes(proposedStart, totalMinutes, scheduleMap, holidaysSet);

        scheduledOperations.push({
            operation_id: op.id,
            sequence: op.sequence,
            work_center: op.work_center,
            scheduled_start: times.actualStart.toISOString(),
            scheduled_end: times.actualEnd.toISOString()
        });

        // Set the clock for the next operation to start when this one actually finishes
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
app.listen(PORT, () => console.log(`PulseCNC V3 Scheduler running on port ${PORT}`));