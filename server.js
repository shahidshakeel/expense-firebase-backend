const cors = require("cors");
const express = require("express");
const admin = require("firebase-admin");

// build service account object from environment variables
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
  universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const app = express();
const port = process.env.PORT || 3000;

app.use(
  cors({
    origin: "https://starfish-app-iuei7.ondigitalocean.app",
  })
);

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.get("/listSubcollections", async (req, res) => {
  const docPath = req.query.docPath;
  if (!docPath) {
    return res.status(400).send("Document path is required");
  }
  const documentRef = db.doc(docPath);
  try {
    const collections = await documentRef.listCollections();
    const collectionNames = collections.map((col) => col.id);
    res.status(200).send(collectionNames);
  } catch (error) {
    console.error("Error listing collections:", error);
    res.status(500).send("Failed to list subcollections");
  }
});

app.get("/getUserExpenses", async (req, res) => {
  const userId = req.query.userId;
  if (!userId) {
    return res.status(400).send("User ID is required");
  }

  const userRef = db.collection("users").doc(userId);
  try {
    // Fetch user document to get approved months and username
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return res.status(404).send("User not found");
    }

    const userData = userDoc.data();
    const approvedMonths = userData.approved || [];
    const username = userData.username;

    // Get subcollections (months with expenses)
    const collections = await userRef.listCollections();
    const expensesData = await Promise.all(
      collections.map(async (collection) => {
        const month = collection.id;
        const approved = approvedMonths.includes(month);
        const expensesSnapshot = await collection.get();
        const expenses = expensesSnapshot.docs.map((doc) => ({
          dayType: doc.data().dayType,
          expenses: doc.data().expenses,
        }));

        return {
          username,
          month,
          approved,
          expenses,
        };
      })
    );

    res.status(200).json(expensesData);
  } catch (error) {
    console.error("Error fetching user expenses:", error);
    res.status(500).send("Failed to fetch user expenses");
  }
});

// Endpoint to fetch all users' expenses with approval status
app.get("/getAllUserExpenses", async (req, res) => {
  try {
    // Fetch all user documents
    const usersSnapshot = await db.collection("users").get();
    if (usersSnapshot.empty) {
      return res.status(404).send("No users found");
    }

    const expensesData = await Promise.all(
      usersSnapshot.docs.map(async (userDoc) => {
        const userData = userDoc.data();
        const approvedMonths = userData.approved || [];
        const username = userData.username;

        // Get subcollections (months with expenses)
        const collections = await userDoc.ref.listCollections();
        const userExpenses = await Promise.all(
          collections.map(async (collection) => {
            const month = collection.id;
            const approved = approvedMonths.includes(month);
            const id = userDoc.id + "/" + collection.id;

            return {
              id,
              username,
              month,
              approved,
            };
          })
        );

        return userExpenses;
      })
    );

    // Flatten the array of arrays to a single array of objects
    const flattenedExpenses = expensesData.flat();

    res.status(200).json(flattenedExpenses);
  } catch (error) {
    console.error("Error fetching all user expenses:", error);
    res.status(500).send("Failed to fetch all user expenses");
  }
});

app.get("/user/:userId/month/:month", async (req, res) => {
  const { userId, month } = req.params;

  try {
    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    // Fetching approved status from user document
    const userData = userDoc.data();
    const approvedMonths = userData.approved || [];
    const isApproved = approvedMonths.includes(month);
    const userName = userData.name;

    const monthRef = userRef.collection(month);
    const snapshot = await monthRef.get();

    if (snapshot.empty) {
      res
        .status(404)
        .json({ message: "No expense records found for this month" });
      return;
    }

    let expenses = [];
    snapshot.forEach((doc) => {
      let expense = doc.data();
      expense.id = doc.id;
      expenses.push(expense);
    });

    res.status(200).json({
      expenses,
      isApproved,
      userName,
    });
  } catch (error) {
    console.error("Error fetching expense details:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/user/:userId/approve/:month", async (req, res) => {
  const { userId, month } = req.params;

  try {
    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    // Get current approved months and add the new month if it's not already included
    const userData = userDoc.data();
    const approvedMonths = new Set(userData.approved || []);

    if (!approvedMonths.has(month)) {
      approvedMonths.add(month);
      await userRef.update({ approved: Array.from(approvedMonths) });
      res.status(200).json({ message: "Month approved successfully" });
    } else {
      res.status(200).json({ message: "Month already approved" });
    }
  } catch (error) {
    console.error("Error approving month:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/user/:userId/reject/:month", async (req, res) => {
  const { userId, month } = req.params;

  try {
    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    // Get current approved months and remove the month if it's included
    const userData = userDoc.data();
    const approvedMonths = new Set(userData.approved || []);

    if (approvedMonths.has(month)) {
      approvedMonths.delete(month);
      await userRef.update({ approved: Array.from(approvedMonths) });
      res.status(200).json({ message: "Month rejected successfully" });
    } else {
      res.status(200).json({ message: "Month not approved previously" });
    }
  } catch (error) {
    console.error("Error rejecting month:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Endpoint to get total, approved, and rejected expenses across all users
app.get("/expenses/summary", async (req, res) => {
  try {
    const usersSnapshot = await db.collection("users").get();
    let totalExpenses = 0;
    let approvedExpenses = 0;
    let rejectedExpenses = 0;

    if (usersSnapshot.empty) {
      return res.status(404).send("No users found");
    }

    for (const userDoc of usersSnapshot.docs) {
      const userData = userDoc.data();
      const approvedMonths = new Set(userData.approved || []);

      // Attempt to list all subcollections (months)
      const collections = await userDoc.ref.listCollections();
      const months = collections.map((col) => col.id);

      for (const month of months) {
        const monthRef = userDoc.ref.collection(month);
        const expensesSnapshot = await monthRef.get();

        if (!expensesSnapshot.empty) {
          expensesSnapshot.forEach((doc) => {
            const expenseEntries = doc.data().expenses || [];
            expenseEntries.forEach((expense) => {
              const expenseAmount = expense.amount;
              totalExpenses += expenseAmount;

              if (approvedMonths.has(month)) {
                approvedExpenses += expenseAmount;
              } else {
                rejectedExpenses += expenseAmount;
              }
            });
          });
        }
      }
    }
    res.status(200).json({
      totalExpenses,
      approvedExpenses,
      rejectedExpenses,
    });
  } catch (error) {
    console.error("Failed to fetch expense summary:", error);
    res.status(500).send("Internal Server Error");
  }
});

app.get("/fetchExpenses", async (req, res) => {
  try {
    const usersCollection = db.collection("users");
    const userSnapshot = await usersCollection.get();
    const usersWithExpenses = await Promise.all(
      userSnapshot.docs.map(async (userDoc) => {
        const user = userDoc.data();
        if (!user.months) {
          return {
            id: userDoc.id,
            username: user.username,
            approved: user.approved,
            expenses: {},
          };
        }
        const expensesPromises = user.months.map((month) =>
          userDoc.ref
            .collection("expenses")
            .doc(month)
            .get()
            .then((monthDoc) => ({
              [month]: monthDoc.exists()
                ? {
                    ...monthDoc.data(),
                    dates: Object.entries(monthDoc.data() || {}).map(
                      ([date, details]) => ({ date, ...details })
                    ),
                  }
                : {},
            }))
        );
        const expensesResults = await Promise.all(expensesPromises);
        const expenses = expensesResults.reduce(
          (acc, curr) => ({ ...acc, ...curr }),
          {}
        );
        return {
          id: userDoc.id,
          username: user.username,
          approved: user.approved,
          expenses,
        };
      })
    );
    res.status(200).json(usersWithExpenses);
  } catch (error) {
    console.error("Failed to fetch expenses:", error);
    res.status(500).send("Failed to fetch expenses");
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
