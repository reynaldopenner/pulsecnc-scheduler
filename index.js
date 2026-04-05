const express = require('express');
const app = express();
app.use(express.json());

// --- 1. HELPER FUNCTION: Build Virtual Calendars ---
function buildCalendars(workingHoursArray, holidaysArray) {
    // Maps your text days (English or Spanish) to JavaScript's 0-6 day numbers
    const dayMap = { 
        "Sunday": 0, "Domingo": 0, 
        "Monday": 1, "Lunes": 1, 
        "Tuesday": 2, "Martes": 2, 
        "Wednesday": 3, "Miércoles": 3, "Miercoles": 3,
        "Thursday": 4, "Jueves": 4, 
        "Friday": 5, "Viernes": 5, 
        "Saturday": 6, "Sábado": 6, "Sabado": 6 
    };
    
    // Create a 2D map: scheduleMap[DayNumber][Hour] = true/false
    const scheduleMap = {};
    for(let i=0; i<=6; i++) scheduleMap[i] = {}; 

    workingHoursArray.forEach(wh => {
        const dayNum = dayMap[wh.day];
        if (dayNum !== undefined) {
            scheduleMap[dayNum][wh.hour] = wh.active;
        }
    });

    // Create a fast-lookup Set for holidays
    const holidaysSet = new Set();
    if (holidaysArray) {
        holidaysArray.forEach(h => {
            const dateStr = h.split('T')[0]; // Grabs just "YYYY-MM-DD"
            holidaysSet.add(dateStr);
        });
    }

    return { scheduleMap, holidaysSet };
}

// --- 2. HELPER FUNCTION: The Calendar-Aware Clock ---
function calculateEndDate(startDateObj, totalMinutes, scheduleMap, holidaysSet) {
    let currentTime = new Date(startDateObj);
    let minutesLeft = totalMinutes;

    // Failsafe: Ensure we don't start a job during off-hours
    // If the start time is invalid, push the clock forward until the shop opens
    while (true) {
        const dateStr = currentTime.toISOString().split('T')[0];
        const isHoliday = holidaysSet.has(dateStr);
        const isWorkingHour = scheduleMap[currentTime.getDay()][currentTime.getHours()] === true;
        
        if (!isHoliday && isWorkingHour) break; 
        currentTime.setMinutes(currentTime.getMinutes() + 1); // Step forward 1 minute
    }

    // Step forward minute-by-minute, only burning time when the shop is active
    while (minutesLeft > 0) {
        const dateStr = currentTime.toISOString().split('T')[0];
        const dayNum = currentTime.getDay();
        const hour = currentTime.getHours();

        const isHoliday = holidaysSet.has(dateStr);
        const isWorkingHour = scheduleMap[dayNum][hour] === true;

        if (!isHoliday && isWorkingHour) {
            minutesLeft--; // Valid work minute, deduct it from the job
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
    
    // Compile the calendars
    const { scheduleMap, holidaysSet } = buildCalendars(working_hours, holidays);

    let currentTime = new Date(start_date);
    const scheduledOperations = [];

    operations.forEach(op => {
        const totalMinutes = op.setup_time + op.run_time;
        
        // Mark the start time (this will automatically be pushed to open hours by the function)
        const opStart = new Date(currentTime);
        
        // Calculate the end time using our custom calendar logic
        const opEnd = calculateEndDate(opStart, totalMinutes, scheduleMap, holidaysSet);

        scheduledOperations.push({
            operation_id: op.id,
            sequence: op.sequence,
            work_center: op.work_center,
            scheduled_start: opStart.toISOString(),
            scheduled_end: opEnd.toISOString()
        });

        // The next operation starts exactly when this one finishes
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