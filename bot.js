const { Telegraf, Markup } = require("telegraf");
const { MongoClient } = require("mongodb");
const express = require("express");
require("dotenv").config();

const MONGO_URI = process.env.MONGO_URI;
const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);

const client = new MongoClient(MONGO_URI);
const dbName = "your_database_name";
let db;

// User and Admin states
const userStates = new Map();
const adminStates = new Map();

// Connect to MongoDB
async function connectDB() {
  try {
    await client.connect();
    db = client.db(dbName);
    console.log("MongoDB connected!");
  } catch (err) {
    console.error("Failed to connect to MongoDB:", err);
    process.exit(1);
  }
}

const bot = new Telegraf(TOKEN);

// Set up Express server for webhooks
const app = express();
app.use(express.json());

// Helper function to generate order reference
let orderCounter = 1000;
function generateOrderReference() {
  orderCounter += 1;
  return `ORD${orderCounter}`;
}

// Start command
bot.start((ctx) => {
  const userId = ctx.from.id;

  if (userId === ADMIN_ID) {
    ctx.reply(
      `Welcome back, Admin!`,
      Markup.inlineKeyboard([
        Markup.button.callback("Change Order Status", "admin_change_status"),
        Markup.button.callback("See All Orders", "admin_see_all_orders"),
      ])
    );
  } else {
    ctx.reply(
      `Welcome! Please choose an option:`,
      Markup.inlineKeyboard([
        Markup.button.callback("Place Order", "user_place_order"),
        Markup.button.callback("Order Status", "user_check_status"),
      ])
    );
  }
});

// Admin change order status flow
bot.action("admin_change_status", (ctx) => {
  adminStates.set(ctx.from.id, { step: "awaiting_reference" });
  ctx.reply("Please provide the order reference.");
});

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;

  // Check if user is admin and in admin state
  if (adminStates.has(userId)) {
    const adminState = adminStates.get(userId);

    if (adminState.step === "awaiting_reference") {
      adminState.reference = ctx.message.text;
      adminState.step = "awaiting_status";
      adminStates.set(userId, adminState);
      ctx.reply("Please provide the new status for the order.");
    } else if (adminState.step === "awaiting_status") {
      const ordersCollection = db.collection("orders");
      const orderReference = adminState.reference;
      const newStatus = ctx.message.text;

      const order = await ordersCollection.findOne({
        order_reference: orderReference,
      });
      if (!order) {
        ctx.reply("Order not found. Please try again.");
        adminStates.delete(userId);
        return;
      }

      await ordersCollection.updateOne(
        { order_reference: orderReference },
        { $set: { status: newStatus } }
      );

      try {
        await bot.telegram.sendMessage(
          order.user_id,
          `Your order ${orderReference} has been updated to: ${newStatus}`
        );
        ctx.reply(`Order ${orderReference} status updated to: ${newStatus}`);
      } catch (error) {
        ctx.reply(`Order status updated, but user notification failed.`);
      }

      adminStates.delete(userId);
    }
    return; // Exit admin handling
  }

  // Check if user is in user order flow
  if (userStates.has(userId)) {
    const userState = userStates.get(userId);

    switch (userState.step) {
      case "NAME":
        userState.name = ctx.message.text;
        userState.step = "EMAIL";
        ctx.reply("Thank you! Now, please provide your email address.");
        break;

      case "EMAIL":
        userState.email = ctx.message.text;
        userState.step = "PHONE";
        ctx.reply("Got it! Please provide your phone number.");
        break;

      case "PHONE":
        userState.phone = ctx.message.text;
        userState.step = "ADDRESS";
        ctx.reply("Thanks! Lastly, please provide your shipping address.");
        break;

      case "ADDRESS":
        const shippingAddress = ctx.message.text;

        const shippingDate = new Date();
        shippingDate.setDate(shippingDate.getDate() + 3);

        const ordersCollection = db.collection("orders");
        const orderReference = generateOrderReference();

        await ordersCollection.insertOne({
          order_reference: orderReference,
          user_id: userId,
          name: userState.name,
          email: userState.email,
          phone: userState.phone,
          shipping_address: shippingAddress,
          status: "Pending",
          shipping_date: shippingDate,
        });

        // Notify the admin
        try {
          await bot.telegram.sendMessage(
            ADMIN_ID,
            `New order placed:\n\n` +
              `Order Ref: ${orderReference}\n` +
              `Name: ${userState.name}\n` +
              `Email: ${userState.email}\n` +
              `Phone: ${userState.phone}\n` +
              `Shipping Address: ${shippingAddress}\n` +
              `Shipping Date: ${shippingDate.toLocaleDateString()}\n` +
              `Status: Pending`
          );
        } catch (error) {
          console.error("Failed to notify the admin:", error);
        }

        ctx.reply(
          `Order placed successfully!\nOrder Ref: ${orderReference}\nShipping Date: ${shippingDate.toLocaleDateString()}`,
          Markup.inlineKeyboard([
            Markup.button.callback("Check Order Status", "user_check_status"),
          ])
        );

        userStates.delete(userId); // Clear user data
        break;

      default:
        ctx.reply("Invalid input. Please restart the process using /start.");
        userStates.delete(userId);
    }
  }
});

// User place order flow
bot.action("user_place_order", (ctx) => {
  userStates.set(ctx.from.id, { step: "NAME" });
  ctx.reply("Please enter your name to start the order process.");
});

// User check status
bot.action("user_check_status", async (ctx) => {
  const ordersCollection = db.collection("orders");
  const userId = ctx.from.id;

  const order = await ordersCollection.findOne(
    { user_id: userId },
    { sort: { _id: -1 } }
  );
  if (order) {
    ctx.reply(
      `Order Ref: ${order.order_reference}\nStatus: ${order.status}\n` +
        `Shipping Date: ${new Date(order.shipping_date).toLocaleDateString()}`
    );
  } else {
    ctx.reply("No orders found.");
  }
});

// Webhook setup
const WEBHOOK_URL =
  process.env.WEBHOOK_URL || "https://your-vercel-url.vercel.app/webhook";
bot.telegram.setWebhook(WEBHOOK_URL);

// Express route to handle the webhook
app.use(bot.webhookCallback("/webhook"));

// Start the Express server
app.listen(process.env.PORT || 3000, () => {
  console.log("Bot is running...");
});

// Connect to the database and launch the bot
async function startBot() {
  await connectDB();
  console.log("Bot is connected to MongoDB!");
  app.listen(process.env.PORT || 3000);
}

startBot();
