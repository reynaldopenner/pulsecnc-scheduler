const express = require('express');
const app = express();
app.use(express.json());

function getShopTime(dateObj, tzOffsetHours) {
    return new Date(dateObj.getTime() + (tzOffsetHours * 3600000));
}

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

function buildLaborMap(existingTasks, scheduleMap, holidaysSet, tzOffsetHours) {
    const laborMap = {}; 
    if (!existingTasks) return laborMap;

    existingTasks.forEach(task => {
        // THE FIX: Skip this loop iteration if Bubble sent a null task
        if (!task || !task.s || !task.e) return; 

        let current = new Date(task.s);
        const end = new Date(task.e);
        
        while (current < end) {
            const shopTime = getShopTime(current, tzOffsetHours);
            const dateStr = shopTime.toISOString().split('T')[0];
            const dayNum = shopTime.getUTCDay();
            const hour = shopTime.getUTCHours();

            const isHoliday = holidaysSet.has(dateStr);
            const isWorkingHour = scheduleMap[dayNum][hour] === true;

            if (!isHoliday && isWorkingHour) {
                if (!laborMap[dateStr]) laborMap[dateStr] = 0;
                laborMap[dateStr]++;
            }
            current.setMinutes(current.getMinutes() + 1);
        }
    });
    return laborMap;
}

function isMachineBusy(machineName, currentTime, existingTasks) {
    if (!existingTasks) return false;
    return existingTasks.some(task => {
        // THE FIX: Check if task exists before reading properties
        if (!task || !task.s || !task.e) return false; 
        
        const start = new Date(task.s);
        const end = new Date(task.e);
        return task.m === machineName && currentTime >= start && currentTime < end;
    });
}

function calculateOperationTimes(op, startDateObj, scheduleMap, holidaysSet, tzOffsetHours, existingTasks, dailyLaborMap, laborLimit) {
    let currentTime = new Date(startDateObj);
    let minutesLeft = Math.ceil(op.setup_time + op.run_time);

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
        
        if (!isHoliday && isWorkingHour && !machineBusy && !laborFull) break; 
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
        const machineBusy = isMachineBusy(op.work_center, currentTime, existingTasks);

        const currentDayLabor = dailyLaborMap[dateStr] || 0;
        const laborFull = currentDayLabor >= laborLimit;

        if (!isHoliday && isWorkingHour && !machineBusy && !laborFull) {
            minutesLeft--; 
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

app.post('/api/schedule', (req, res) => {
    const { job_id, start_date, operations, working_hours, holidays, tz_offset, daily_labor_minutes, existing_tasks } = req.body;
    
    const safeOffset = tz_offset !== undefined ? parseFloat(tz_offset) : 0;
    const laborLimit = daily_labor_minutes || 999999; 
    const safeExistingTasks = existing_tasks || [];

    console.log(`\n--- FINITE SCHEDULING REQUEST: ${job_id} ---`);
    console.log(`Shop Labor Limit: ${laborLimit} minutes/day`);

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