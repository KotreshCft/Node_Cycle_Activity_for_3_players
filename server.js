// ---------------------------------- IMPORTS ----------------------------------
const osc = require('osc');
const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const socketIo = require('socket.io');
const { ReadlineParser } = require('@serialport/parser-readline');
const readline = require('readline');
const { SerialPort } = require('serialport');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const { parse } = require('json2csv');
const path = require('path');
const chalk = require('chalk');

// ---------------------------------- INITIALIZATION ----------------------------------
const app = express();
const port = 3000;
const BAUDRATE = 115200;
let RECONNECT_INTERVAL = 1000;

let portName = '';
let sendingData = false;
let serialPort;
let parser;

// ---------------------------------- SERIAL PORT FUNCTIONS ----------------------------------
// Function to find the port dynamically
function findPortName() {
    return new Promise((resolve, reject) => {
        SerialPort.list().then(ports => {
            // Log only the path and manufacturer of available COM ports
            console.log(`------Available Ports------`)
            ports.forEach(port => {
                console.log(`Port: ${port.path}, Manufacturer: ${port.manufacturer || 'Unknown'}`);
            });
            console.log(`----------------------------`)
            const portInfo = ports.find(port => {
                // Adjust the criteria based on your device's information
                return port.manufacturer && port.manufacturer.includes('Silicon Labs');
            });
            if (portInfo) {
                resolve(portInfo.path);
            } else {
                reject(new Error('No matching port found for Silicon Labs CP210x device.'));
            }
        }).catch(err => {
            reject(err);
        });
    });
}

// Use dynamic port name
findPortName().then(foundPortName => {
    console.log(`Found port: ${chalk.bgWhite.bold(`   ${chalk.blue.bold(foundPortName)}   `)}`);
    // sendOSCMessage("/comPortFound", foundPortName);
    portName = foundPortName; // Set the global portName variable
}).catch(err => {
    if (err.message === '"path" is not defined: undefined') {
        // Ignore the error and continue execution
        // console.warn('Ignoring "path" is not defined error.');
    } else {
        // Handle other errors
        console.error(`Failed to start serial communication: ${err.message}`);
    }
});

// Function to initialize serial port
function initializeSerialPort() {
    try {
        serialPort = new SerialPort({ path: portName, baudRate: BAUDRATE }, (err) => {
            if (err) {
                // Check if the error message contains the specific path-related error
                if (err.message.includes('"path" is not defined:')) {
                    // Ignore this specific error
                    // console.warn('Ignoring "path" is not defined error.'));
                } else {
                    console.error('Error opening port:', err.message);
                    setTimeout(initializeSerialPort, RECONNECT_INTERVAL);
                }
            } else {
                console.log(chalk.green('Serial port opened successfully'));
                setupParser();

                setImmediate(() => {
                    serialPort.write('f', (err) => {
                        if (err) {
                            console.error('Error writing to port:', err.message);
                        } else {
                            console.log('Sent "f" to serial port');
                            stopSendingData();
                            handleInput();
                        }
                    });
                });
            }
        });

        serialPort.on('close', () => {
            console.warn('Serial port closed. Attempting to reconnect...');
            setTimeout(initializeSerialPort, RECONNECT_INTERVAL);
        });

        serialPort.on('error', (err) => {
            console.error('Serial port error:', err.message);
        });
    } catch (error) {
        // Check if the caught error message contains the specific path-related error
        if (error.message.includes('"path" is not defined:')) {
            // console.warn('Ignoring "path" is not defined error.');
        } else {
            console.error('Failed to initialize serial port:', error.message);
        }
        setTimeout(initializeSerialPort, RECONNECT_INTERVAL);
    }
}

// Function to setup parser and handle data
// function setupParser() {
//     console.log(chalk.blue('Setting up parser...'));
//     parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));
//     parser.on('data', (data) => {
//         console.warn(data);
//         sendOSCMessage('/cycles/data',data);
//         // Parse the value from 1:0:0:1 to 1, 0, 0, 1
//         //const values = data.split(':').map(Number);
//         //console.log('Parsed values:', values); 
//     });
//     parser.on('error', (err) => {
//         console.error('Error on parser:', err);
//     });
// }
let latestData = '0:0:0:0'; // Initial data to send continuously
let dataReceived = false; // Flag to indicate if data was received

function setupParser() {
    console.log(chalk.blue('Setting up parser...'));

    parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));

    // When data is received from the parser
    parser.on('data', (data) => {
        console.log('Data received:', data);
        latestData = data; // Update the latest data
        dataReceived = true; // Set flag indicating data was received
        sendOSCMessage('/cycles/data', latestData); // Send received data
    });

    parser.on('error', (err) => {
        console.error('Error on parser:', err);
    });
}

// Function to continuously send the latest data (or 0:0:0:0 by default)
function sendContinuousData() {
    setInterval(() => {
        if (!dataReceived) {
            sendOSCMessage('/cycles/data', '0:0:0:0'); // Send default if no new data
        }
        dataReceived = false; // Reset flag to check for new data in the next cycle
    }, 1000); // Send data every second (adjust interval as needed)
}

sendContinuousData();

// Function to start sending data
function startSendingData() {
    if (!sendingData) {
        sendingData = true;
        if (serialPort && serialPort.isOpen) {
            serialPort.write('s');
        }
        console.log(chalk.green('Started receiving data.'));
    } else {
        console.warn('Data is already being received.');
    }
}

// Function to stop sending data
function stopSendingData() {
    if (sendingData) {
        sendingData = false;
        if (serialPort && serialPort.isOpen) {
            serialPort.write('f');
        }
        console.error('Stopped receiving data.');
    } else {
        console.warn('Data is not being received.');
    }
}

// Function to handle console input
function handleInput() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.question('Enter "s" to start, "f" to stop: ', (input) => {
        if (input.toLowerCase() === 's') {
            startSendingData();
        } else if (input.toLowerCase() === 'f') {
            stopSendingData();
        } else {
            console.error('Invalid input. Try again.');
            handleInput(); // Call handleInput again for invalid input
        }
        rl.close(); // Close the readline interface
    });
}

// ---------------------------------- DATABASE CONFIGURATION ----------------------------------
const db = new sqlite3.Database('./database.db', err => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        createTables();
    }
});

// Create tables if they don't exist
function createTables() {
    const query = `
    CREATE TABLE IF NOT EXISTS user_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player1 TEXT,
      player2 TEXT,
      totalPedalCount TEXT,
      date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`;

    db.run(query, err => {
        if (err) {
            console.error('Error creating user_data table:', err.message);
        } else {
            console.log('user_data table created successfully.');
        }
    });
}
// ---------------------------------- SOCKET.IO FUNCTIONS ----------------------------------

const server = http.createServer(app);
const io = socketIo(server);

// Handle new client connections and define event listeners
io.on('connection', (socket) => {
    console.log('New client connected');

    // Event listener for player data
    socket.on('playerData', handlePlayerData);

    socket.on('targetValue', (data) => {
        handleGameEvent('gameTarget', 'Target', data);
    });

    // Event listener for game start
    socket.on('gameStart', (data) => {
        handleGameEvent('gameStart', 'Start', true);
    });

    // Event listener for game restart
    socket.on('gameRestart', (data) => {
        isSending = false;
        handleGameEvent('gameRestart', 'Restart', true);
        stopSendingData();
    });

    // Event listener for client disconnection
    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

// ---------------------------------- EVENT HANDLER FUNCTIONS ----------------------------------

// Handle player data
function handlePlayerData(data) {
    console.log('Received player data:', data);
    const wrappedData = { players: data }; // Wrap the data in an object
    sendOSCMessage("/players/data", JSON.stringify(wrappedData));// Send data as a JSON string
}

// Handle game start/restart events
function handleGameEvent(eventName, eventLabel, data) {
    sendOSCMessage(`/${eventName}`, data);
    console.log(`${eventLabel} received from Client:`, data);
}

// ---------------------------------- OSC FUNCTIONS ----------------------------------

// Create and open OSC client
const udpPort = new osc.UDPPort({
    localAddress: "0.0.0.0",
    localPort: 57121,
    remoteAddress: "127.0.0.1",
    remotePort: 7000
});
udpPort.open();
// Store callbacks for specific OSC addresses
const addressHandlers = {};
// Register a callback function (delegate) for a specific OSC address
function registerAddressHandler(address, callback) {
    addressHandlers[address] = callback;
}
// Send OSC messages (with dynamic value handling)
function sendOSCMessage(address, value) {
    const message = createDynamicOSCMessage(address, value);
    udpPort.send(message, udpPort.options.remoteAddress, udpPort.options.remotePort);
    // console.warn(`Message sent now..`);
}
// Handle incoming OSC messages dynamically based on address and value type
udpPort.on("message", (oscMsg) => {
    const address = oscMsg.address;
    const value = oscMsg.args[0].value;

    if (addressHandlers[address]) {
        addressHandlers[address](value);
    } else {
        console.log(`No handler registered for address: ${address}`);
    }
});
// Function to create dynamic OSC message based on the data type
function createDynamicOSCMessage(address, value) {
    let type = '';
    let parsedValue = value;

    if (typeof value === 'string') {
        type = 's'; // string
    } else if (typeof value === 'number') {
        if (Number.isInteger(value)) {
            type = 'i'; // integer
        } else {
            type = 'f'; // float
        }
    } else if (typeof value === 'boolean') {
        type = 'T'; // boolean true or false
        parsedValue = value ? 1 : 0;
    } else if (typeof value === 'object') {
        type = 's'; // JSON object serialized as string
        parsedValue = JSON.stringify(value);
    } else {
        throw new Error('Unsupported data type');
    }

    // console.log(`Type: ${type}, Value: ${parsedValue}`);
    return {
        address: address,
        args: [{ type: type, value: parsedValue }]
    };
}
// Handle incoming OSC messages
udpPort.on("message", (oscMsg) => {
    console.log("Received OSC message:", oscMsg);

    switch (oscMsg.address) {
        case '/sendInput':
            handleInputMessage(oscMsg.args[0]);
            break;

        case '/sendRestart':
            handleRestartMessage();
            break;

        case '/userGameData':
            handleUserGameData(oscMsg);

            break;

        default:
            console.log('Unknown OSC address:', oscMsg.address);
    }
});

// ---------------------------------- OSC MESSAGE HANDLERS ----------------------------------

// Handle '/sendInput' message
function handleInputMessage(inputValue) {
    console.log('Received Message:', inputValue);

    if (inputValue === 's') {
        console.log('Started sending data.');
        isSending = true; // Set flag to true
        // dummyDataStart();  // FOR DUMMYDATA 
        startSendingData(); // Send 's' to Serial board
    } else if (inputValue === 'f') {
        console.log('Stopped sending data.');
        isSending = false; // Set flag to false
        stopSendingData(); // Send 'f' to Serial board
    }
}

// Handle '/sendRestart' message
function handleRestartMessage() {
    console.log('Received restart message');
    io.emit('restartApp', true);
    console.log('Emitting restartApp event to all clients');
}
// Handle '/userGameData' message and store in database
async function handleUserGameData(oscMessage) {
    if (oscMessage.args && oscMessage.args.length >= 2) {
        let player1Name = oscMessage.args[0];
        let player2Name = oscMessage.args[1];
        let totalPedalCount = oscMessage.args[2];
        console.log("Extracted userData:", { player1Name, player2Name });

        // Insert data into the SQLite database
        insertUserData(player1Name, player2Name, totalPedalCount);
        // const Winerdata = await getSqlData();
        // console.log(Winerdata);
        // sendOSCMessage('/winerData', Winerdata);
    } else {
        console.log("Invalid number of arguments received in OSC message.");
    }
}



// function getSqlData() {
//     const query = `SELECT player1, totalPedalCount,id 
//                    FROM user_data 
//                    ORDER BY pedal_count DESC`;

//     return new Promise((resolve, reject) => {
//         db.all(query, [], (error, results) => {
//             if (error) {
//                 console.error('Error fetching data:', error.message);
//                 reject(error); // Reject the promise if there is an error
//             } else {
//                 // Map results to an array containing only the necessary data
//                 const resultArray = results.map(row => ({
//                     player_name: row.player_name,
//                     pedal_count: row.pedal_count
//                 }));

//                 console.log('Players data ordered by pedal count:', resultArray);
//                 resolve(resultArray); // Resolve the promise with the array of results
//             }
//         });
//     });
// }


// ---------------------------------- DATABASE INSERTION ----------------------------------
// Insert user data into the database
function insertUserData(player1, player2, totalPedalCount) {
    const query = `
        INSERT INTO user_data (player1, player2, totalPedalCount) 
        VALUES (?, ?, ?)
    `;

    db.run(query, [player1, player2, totalPedalCount], function (err) {
        if (err) {
            console.error('Error inserting user data:', err.message);
        } else {
            console.log(`Inserted user data with row ID: ${this.lastID}`);
        }
    });
}
// ---------------------------------- CONSTANTS ----------------------------------

// Constants for rotation count range
const MIN_ROTATIONS_PER_SECOND = 10;
const MAX_ROTATIONS_PER_SECOND = 70;

// Constants for time intervals
const DEFAULT_SEND_INTERVAL = 3000 / 10; // 100ms interval for fixed player updates
const ROTATION_UPDATE_INTERVAL = 3000; // 1 second update interval

// Ratio thresholds
const ROTATION_RATIO_THRESHOLD = 0.5; // 70% chance for a player to get 1
const ZERO_PLAYERS_COUNT = 0; // Number of players to always have 0 rotations

// ---------------------------------- DUMMY DATA GENERATOR ----------------------------------
let isSending = false; // Control variable to manage sending status
let numPlayers = 6;    // Total number of players (assumed to be 2 players for pairs)
let zeroPlayers = new Set(); // To hold indices of players who will always have a value of 0
let lastValueWasOne = false;  // Flag to track the last generated value

let pedalCounts = new Array(numPlayers).fill(0);  // Pedal count for each player
let lastValues = new Array(numPlayers).fill(0);   // Track the last value for each player (for transition detection)
let totalPedalCounts = new Array(numPlayers).fill(0);  // Total pedal count for distance calculation
let rotationCounts = new Array(numPlayers).fill(0);  // Track rotations for each player
let speedPerPlayer = new Array(numPlayers).fill(0);  // Speed for each player (pedals per second)
let distancePerPlayer = new Array(numPlayers).fill(0);  // Distance traveled by each player (km)

const wheelCircumference = 0.47;  // This represents the distance covered by one pedal (in meters)

// Function to set the number of players
function setNumberOfPlayers(number) {
    numPlayers = number;
    rotationCounts = new Array(numPlayers).fill(0); // Initialize rotation counts array

    zeroPlayers.clear();
    while (zeroPlayers.size < ZERO_PLAYERS_COUNT) {
        const randomIndex = Math.floor(Math.random() * numPlayers);
        zeroPlayers.add(randomIndex);
    }
}
function generateAlternatingValue(playerIndex) {
    if (lastValueWasOne[playerIndex]) {
        lastValueWasOne[playerIndex] = false;
        return 0;  // If the last value was 1, return 0
    } else {
        lastValueWasOne[playerIndex] = true;
        return 1;  // If the last value was 0, return 1
    }
}

// Function to generate pairs or random values for each player individually
function generateValueWithRatio() {
    const playerValues = [];

    for (let i = 0; i < numPlayers; i++) {
        const isPairMode = Math.random() < ROTATION_RATIO_THRESHOLD; // 50% chance to generate in "pair mode"

        if (isPairMode) {
            // Generate alternating values for each player independently
            playerValues.push(generateAlternatingValue(i));
        } else {
            // Generate random identical values for each player (either 0 or 1)
            const randomValue = Math.random() < 0.5 ? 0 : 1;
            playerValues.push(randomValue);
        }
    }

    return playerValues;
}

// Function to process input and count rotations for each player
function processInput(playerValues) {
    for (let i = 0; i < numPlayers; i++) {
        if (playerValues[i] === 1) {
            rotationCounts[i]++;
        }
    }
}

// Function to send player data
function sendPlayerData() {
    if (!isSending) return; // Only send data if isSending is true

    const playerValues = [];

    // Generate values once and apply to all players
    const generatedValues = generateValueWithRatio();

    for (let i = 0; i < numPlayers; i++) {
        if (zeroPlayers.has(i)) {
            playerValues.push(0); // If player is in zeroPlayers, their value is always 0
        } else {
            playerValues.push(generatedValues[i % 2]); // Apply the generated values in pair
        }
    }

    // Log the generated player values for visualization
    // console.log(playerValues.join(':'));
    const data = playerValues.join(':');

    // Process the input to count rotations
    processInput(playerValues);
    console.warn(data);

    // Send OSC message with player data
    sendOSCMessage('/cycles/data', data);

    // Detect pedal counts based on value transitions (1 -> 0)
    detectPedalCounts(playerValues);

    // Call sendPlayerData again after a fixed interval
    setTimeout(sendPlayerData, DEFAULT_SEND_INTERVAL);
}

function setRandomRotationCount() {
    if (!isSending) return;

    // Randomly set the number of rotations per second between MIN and MAX
    currentRotationCount = Math.floor(Math.random() * (MAX_ROTATIONS_PER_SECOND - MIN_ROTATIONS_PER_SECOND + 1)) + MIN_ROTATIONS_PER_SECOND;
    currentInterval = 1000 / currentRotationCount; // Adjust the interval accordingly

    //console.log("Rotation Count Set to:", currentRotationCount, "Interval:", currentInterval, "ms");
}
// Function to update the rotation count and interval every second
function updateRotationPerSecond() {
    setRandomRotationCount();
    setTimeout(updateRotationPerSecond, ROTATION_UPDATE_INTERVAL); // Update every second
}

setNumberOfPlayers(numPlayers); // Set the initial number of players
updateRotationPerSecond(); // Start updating the rotation count every second

function dummyDataStart() {
    isSending = true;
    startCalculations();
    sendPlayerData();
}
// --------------------------- CALCULATE SPEED, DISTANCE --------------------------
// Function to detect pedal counts for each player based on value transitions (1 -> 0)
function detectPedalCounts(playerValues) {
    for (let i = 0; i < numPlayers; i++) {
        // If current value is 0 and last value was 1, count as a pedal
        if (lastValues[i] === 1 && playerValues[i] === 0) {
            pedalCounts[i]++;
            totalPedalCounts[i]++;
        }
        // Update the last value for the next check
        lastValues[i] = playerValues[i];
    }
}

// Function to calculate speed (in km/h) for each player based on pedals per second
function calculateSpeed(intervalInSeconds) {
    for (let i = 0; i < numPlayers; i++) {
        // Speed in km/h: (pedals per second * pedalFactor (meters per pedal) * 3600 seconds per hour) / 1000 (to convert to km)
        let pedalsPerSecond = pedalCounts[i] / intervalInSeconds;
        speedPerPlayer[i] = (pedalsPerSecond * wheelCircumference * 3600) / 1000;

        // Reset pedal count after calculation for the next interval
        pedalCounts[i] = 0;
    }
    console.log("Speed (km/h):", speedPerPlayer);
}

// Function to calculate distance traveled (in kilometers) for each player
function calculateDistance() {
    for (let i = 0; i < numPlayers; i++) {
        // Distance in km: (total pedal count * wheelCircumference (meters per pedal)) / 1000 (to convert to km)
        let distance = (totalPedalCounts[i] * wheelCircumference) / 1000;
        // Store the formatted distance with two decimal places
        distancePerPlayer[i] = distance.toFixed(2);
    }
    console.log("Distance (km):", distancePerPlayer);
}



// Start calculating speed and distance at regular intervals
function startCalculations() {
    setInterval(() => {
        // console.log("Pedal counts (current cycle):", pedalCounts);
        // console.log("Total pedal counts (cumulative):", totalPedalCounts); 
        calculateSpeed(1);  // Calculate speed every 1 second
        calculateDistance();  // Update distance regularly
    }, 1000);  // Calculate every second
}

// ---------------------------------- ROUTES ----------------------------------

// Serve the HTML file
app.use(express.static('public'));
// Serve the settings page
app.get('/settings', (req, res) => {
    res.sendFile(__dirname + '/public/settings.html');
});
// Serve node_modules as a static directory
app.use('/node_modules', express.static(path.join(__dirname, 'node_modules')));
// Middleware to parse JSON bodies
app.use(bodyParser.json());

// Export user data as CSV
app.get('/export', (req, res) => {
    const query = 'SELECT * FROM user_data';
    db.all(query, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
        exportUserDataAsCSV(res, rows);
    });
});

// Route to reset the database
app.post('/reset', (req, res) => {
    db.run('DROP TABLE IF EXISTS user_data', (err) => {
        if (err) {
            res.status(500).json({ success: false, error: err.message });
            return;
        }
        console.log("User table Dropped and Recreated..!")
        createTables(); // Recreate the table

        // Send reset message to Unity
        sendOSCMessage("/reset", "true");

        res.json({ success: true });
    });
});
// ---------------------------------- CSV EXPORT FUNCTION ----------------------------------
// Export user data to CSV
function exportUserDataAsCSV(res, rows) {
    const fields = ['id', 'player1', 'player2', 'totalPedalCount'];
    const opts = { fields };

    const modifiedRows = rows.map(row => ({
        id: row.id,
        player1: row.player1,
        player2: row.player2,
        totalPedalCount: row.totalPedalCount,
    }));

    try {
        const csv = parse(modifiedRows, opts);
        res.header('Content-Type', 'text/csv');
        res.attachment('user_data.csv');
        res.send(csv);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}

// ---------------------------------- REGISTERING ADDRESS HANDLERS ----------------------------------

registerAddressHandler('/players/data', (value) => {
    console.log("Received JSON data from /players/data:", JSON.parse(value));
});

registerAddressHandler('/cycles/data', (value) => {
    console.log("Received string data from /cycles/data:", value);
});

registerAddressHandler('/gameStart', (value) => {
    console.log(`Game Start triggered: ${value}`);
});

registerAddressHandler('/gameRestart', (value) => {
    console.log(`Game Restart triggered: ${value}`);
});

// ---------------------------------- SERVER STARTUP ----------------------------------

// Initialize serial port and start the server
console.log(chalk.gray('Initializing serial port...'));
initializeSerialPort();

function getServerIPAddress() {
    const interfaces = os.networkInterfaces();
    for (const interfaceName in interfaces) {
        const addresses = interfaces[interfaceName];
        for (const addressInfo of addresses) {
            if (addressInfo.family === 'IPv4' && !addressInfo.internal) {
                return addressInfo.address;
            }
        }
    }
    return '0.0.0.0';
}

console.log('Starting HTTP server...');
server.listen(port, '0.0.0.0', () => {
    const ipAddress = getServerIPAddress();
    console.log(chalk.green(`Server is running on http://${ipAddress}:${port}`));
});