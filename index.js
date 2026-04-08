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
        if (!task || !task.s || !task.e) return false; 
        const start = new Date(task.s);
        const end = new Date(task.e);
        return task.m === machineName && currentTime >= start && currentTime < end;
    });
}

// --- FORWARD SIMULATION ---
function simulateForward(machineName, op, startDateObj, scheduleMap, holidaysSet, tzOffsetHours, existingTasks, dailyLaborMap, laborLimit) {
    let currentTime = new Date(startDateObj);
    let minutesLeft = Math.ceil(op.setup_time + op.run_time);
    const simLaborMap = { ...dailyLaborMap };

    while (true) {
        const shopTime = getShopTime(currentTime, tzOffsetHours);
        const dateStr = shopTime.toISOString().split('T')[0];
        const dayNum = shopTime.getUTCDay();
        const hour = shopTime.getUTCHours();

        const isHoliday = holidaysSet.has(dateStr);
        const isWorkingHour = scheduleMap[dayNum][hour] === true;
        const machineBusy = isMachineBusy(machineName, currentTime, existingTasks);
        const laborFull = (simLaborMap[dateStr] || 0) >= laborLimit;
        
        if (!isHoliday && isWorkingHour && !machineBusy && !laborFull) break; 
        currentTime.setMinutes(currentTime.getMinutes() + 1); 
    }

    const actualStart = new Date(currentTime);

    while (minutesLeft > 0) {
        const shopTime = getShopTime(currentTime, tzOffsetHours);
        const dateStr = shopTime.toISOString().split('T')[0];
        const dayNum = shopTime.getUTCDay();
        const hour = shopTime.getUTCHours();

        const isHoliday = holidaysSet.has(dateStr);
        const isWorkingHour = scheduleMap[dayNum][hour] === true;
        const machineBusy = isMachineBusy(machineName, currentTime, existingTasks);
        const currentDayLabor = simLaborMap[dateStr] || 0;
        const laborFull = currentDayLabor >= laborLimit;

        if (!isHoliday && isWorkingHour && !machineBusy && !laborFull) {
            minutesLeft--; 
            simLaborMap[dateStr] = currentDayLabor + 1;
        }
        if (minutesLeft > 0) currentTime.setMinutes(currentTime.getMinutes() + 1);
    }
    
    return { machine: machineName, actualStart, actualEnd: currentTime, finalLaborMap: simLaborMap };
}

// --- BACKWARD SIMULATION ---
function simulateBackward(machineName, op, targetEndObj, scheduleMap, holidaysSet, tzOffsetHours, existingTasks, dailyLaborMap, laborLimit) {
    let currentTime = new Date(targetEndObj);
    let minutesLeft = Math.ceil(op.setup_time + op.run_time);
    const simLaborMap = { ...dailyLaborMap };

    // Failsafe: Push backwards to find a free moment to END the operation
    while (true) {
        const shopTime = getShopTime(currentTime, tzOffsetHours);
        const dateStr = shopTime.toISOString().split('T')[0];
        const dayNum = shopTime.getUTCDay();
        const hour = shopTime.getUTCHours();

        const isHoliday = holidaysSet.has(dateStr);
        const isWorkingHour = scheduleMap[dayNum][hour] === true;
        const machineBusy = isMachineBusy(machineName, currentTime, existingTasks);
        const laborFull = (simLaborMap[dateStr] || 0) >= laborLimit;
        
        if (!isHoliday && isWorkingHour && !machineBusy && !laborFull) break; 
        currentTime.setMinutes(currentTime.getMinutes() - 1); 
    }

    const actualEnd = new Date(currentTime);

    // Step backwards to find the START time
    while (minutesLeft > 0) {
        const shopTime = getShopTime(currentTime, tzOffsetHours);
        const dateStr = shopTime.toISOString().split('T')[0];
        const dayNum = shopTime.getUTCDay();
        const hour = shopTime.getUTCHours();

        const isHoliday = holidaysSet.has(dateStr);
        const isWorkingHour = scheduleMap[dayNum][hour] === true;
        const machineBusy = isMachineBusy(machineName, currentTime, existingTasks);
        const currentDayLabor = simLaborMap[dateStr] || 0;
        const laborFull = currentDayLabor >= laborLimit;

        if (!isHoliday && isWorkingHour && !machineBusy && !laborFull) {
            minutesLeft--; 
            simLaborMap[dateStr] = currentDayLabor + 1;
        }
        if (minutesLeft > 0) currentTime.setMinutes(currentTime.getMinutes() - 1);
    }
    
    return { machine: machineName, actualStart: currentTime, actualEnd, finalLaborMap: simLaborMap };
}

// --- MAIN ENDPOINT ---
app.post('/api/schedule', (req, res) => {
    const { job_id, schedule_mode, start_date, target_date, operations, working_hours, holidays, tz_offset, daily_labor_minutes, existing_tasks } = req.body;
    
    const rootStartDate = new Date(start_date);
    if (isNaN(rootStartDate.getTime())) return res.status(400).json({ status: "error", message: "Invalid start_date" });

    const safeOffset = tz_offset !== undefined ? parseFloat(tz_offset) : 0;
    const laborLimit = daily_labor_minutes || 999999; 
    const safeExistingTasks = existing_tasks || [];
    const mode = schedule_mode === "backward" ? "backward" : "forward";

    console.log(`\n--- REQUEST: ${job_id} | MODE: ${mode.toUpperCase()} ---`);

    const { scheduleMap, holidaysSet } = buildCalendars(working_hours, holidays, safeOffset);
    let dailyLaborMap = buildLaborMap(safeExistingTasks, scheduleMap, holidaysSet, safeOffset);
    let scheduledOperations = [];
    let isImpossibleDeadline = false;

    // --- EXECUTE BACKWARD SCHEDULING ---
    if (mode === "backward") {
        const deadline = new Date(target_date);
        if (isNaN(deadline.getTime())) return res.status(400).json({ status: "error", message: "Backward scheduling requires a valid target_date" });

        // Reverse sort: Op 3, then Op 2, then Op 1
        let reverseOps = [...operations].sort((a, b) => b.sequence - a.sequence);
        let currentTime = new Date(deadline);

        reverseOps.forEach(op => {
            const machinesToTest = op.eligible_machines ? op.eligible_machines.split(',').map(m => m.trim()) : ["Unassigned"];
            let bestResult = null;

            machinesToTest.forEach(machine => {
                const simResult = simulateBackward(machine, op, currentTime, scheduleMap, holidaysSet, safeOffset, safeExistingTasks, dailyLaborMap, laborLimit);
                // In backwards mode, we want the machine that starts LATEST (closest to the deadline)
                if (!bestResult || simResult.actualStart > bestResult.actualStart) bestResult = simResult;
            });

            scheduledOperations.push({
                operation_id: op.id, sequence: op.sequence, work_center: bestResult.machine,
                scheduled_start: bestResult.actualStart.toISOString(), scheduled_end: bestResult.actualEnd.toISOString()
            });

            safeExistingTasks.push({ m: bestResult.machine, s: bestResult.actualStart.toISOString(), e: bestResult.actualEnd.toISOString(), t: op.setup_time + op.run_time });
            dailyLaborMap = bestResult.finalLaborMap;
            currentTime = new Date(bestResult.actualStart); // The previous operation must finish before this one starts
        });

        // Check the Fallback: Did Op 1 get pushed into the past?
        if (currentTime < rootStartDate) {
            console.log("WARNING: Deadline impossible. Triggering Forward Fallback.");
            isImpossibleDeadline = true;
            scheduledOperations = []; // Clear the backward schedule
            safeExistingTasks.length = existing_tasks ? existing_tasks.length : 0; // Reset existing tasks
            dailyLaborMap = buildLaborMap(safeExistingTasks, scheduleMap, holidaysSet, safeOffset); // Reset labor map
        } else {
            // Success! Re-sort back to normal order to send to Bubble
            scheduledOperations.sort((a, b) => a.sequence - b.sequence);
        }
    }

    // --- EXECUTE FORWARD SCHEDULING (Or Fallback) ---
    if (mode === "forward" || isImpossibleDeadline) {
        let forwardOps = [...operations].sort((a, b) => a.sequence - b.sequence);
        let currentTime = new Date(rootStartDate);

        forwardOps.forEach(op => {
            const machinesToTest = op.eligible_machines ? op.eligible_machines.split(',').map(m => m.trim()) : ["Unassigned"];
            let bestResult = null;

            machinesToTest.forEach(machine => {
                const simResult = simulateForward(machine, op, currentTime, scheduleMap, holidaysSet, safeOffset, safeExistingTasks, dailyLaborMap, laborLimit);
                // In forward mode, we want the machine that finishes EARLIEST
                if (!bestResult || simResult.actualEnd < bestResult.actualEnd) bestResult = simResult;
            });

            scheduledOperations.push({
                operation_id: op.id, sequence: op.sequence, work_center: bestResult.machine,
                scheduled_start: bestResult.actualStart.toISOString(), scheduled_end: bestResult.actualEnd.toISOString()
            });

            safeExistingTasks.push({ m: bestResult.machine, s: bestResult.actualStart.toISOString(), e: bestResult.actualEnd.toISOString(), t: op.setup_time + op.run_time });
            dailyLaborMap = bestResult.finalLaborMap;
            currentTime = new Date(bestResult.actualEnd); 
        });
    }

    res.json({
        job_id: job_id,
        status: isImpossibleDeadline ? "warning_asap_fallback" : "success",
        estimated_completion_date: scheduledOperations[scheduledOperations.length - 1].scheduled_end,
        schedule: scheduledOperations
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PulseCNC Enterprise Scheduler running on port ${PORT}`));