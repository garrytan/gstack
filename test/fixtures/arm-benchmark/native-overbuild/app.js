const form = document.getElementById('booking-form');
const confirmation = document.getElementById('confirmation');

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(form);
  confirmation.textContent = `Booked for ${data.get('name')}. Confirmation sent to ${data.get('email')}.`;
  confirmation.hidden = false;
});
