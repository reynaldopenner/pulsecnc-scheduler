const express = require('express');
const app = express();

app.use(express.json());

app.post('/api/schedule', (req, res) => {
    // 1. Unpack the payload sent from PulseCNC
    const { job_id, start_date, operations } = req.body;
    
    // 2. Safety Check: Sort operations by sequence number just in case they arrive out of order
    operations.sort((a, b) => a.sequence - b.sequence);

    // 3. Set our running clock to the Job's start date
    let currentTime = new Date(start_date);
    const scheduledOperations = [];

    // 4. The Core Loop
    operations.forEach(op => {
        // Calculate total time in minutes
        const totalMinutes = op.setup_time + op.run_time;

        // Record the start time for this specific operation
        const opStart = new Date(currentTime);
        
        // Add the minutes to calculate the end time
        // (JavaScript Date objects do math in milliseconds, so we multiply minutes by 60,000)
        const opEnd = new Date(currentTime.getTime() + totalMinutes * 60000);

        // Store the results
        scheduledOperations.push({
            operation_id: op.id,
            sequence: op.sequence,
            work_center: op.work_center,
            scheduled_start: opStart.toISOString(),
            scheduled_end: opEnd.toISOString()
        });

        // Push our running clock forward so the next operation starts when this one ends
        currentTime = new Date(opEnd); 
    });

    // 5. Send the finished schedule back
    res.json({
        job_id: job_id,
        status: "success",
        estimated_completion_date: currentTime.toISOString(),
        schedule: scheduledOperations
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PulseCNC Scheduler running on port ${PORT}`));